import os
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from canvas_client import CanvasClient
from fastapi.responses import StreamingResponse
import json
from fastapi.responses import StreamingResponse
import json
import asyncio
import threading
import queue

app = FastAPI(title="Assurance Portal Backend")
canvas = CanvasClient()

# CORS Setup
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# --- Schemas ---
class MappingRequest(BaseModel):
    subject_outcome_id: int
    parent_outcome_id: int
    parent_title: str


# --- Endpoints ---


@app.get("/outcomes/{account_id}/summary")
async def get_summary(account_id: int):
    """Recursively fetches all outcomes in the hierarchy."""
    try:
        data = canvas.get_all_outcomes_recursive(account_id)
        return {"status": "success", "data": data}
    except Exception as e:
        print(f"Summary Error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/outcomes/{account_id}/search")
async def search_outcomes(account_id: int, query: str):
    """Recursively searches for outcomes by title."""
    try:
        results = canvas.search_outcomes_recursive(account_id, query)
        return {"status": "success", "results": results}
    except Exception as e:
        print(f"Search Error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/outcomes/map")
async def map_outcome(req: MappingRequest):
    # Ensure you are using the same logic to update Canvas
    outcome = canvas.get_outcome_details(req.subject_outcome_id)

    # Save the Parent's CODE (title) into the GUID
    new_guid = f"MAPPED_TO:{req.parent_title}"

    base_desc = outcome.get("description", "").split("<hr>")[0]
    new_desc = f"{base_desc}<hr><b>Alignment:</b> Mapped to {req.parent_title}"

    canvas.update_outcome(req.subject_outcome_id, new_guid, new_desc)
    return {"status": "success"}


@app.post("/outcomes/unmap")
async def unmap_outcome(req: MappingRequest):
    """Surgically removes a mapping link."""
    try:
        return canvas.unmap_outcome_surgical(
            req.subject_outcome_id, req.parent_outcome_id, req.parent_title
        )
    except Exception as e:
        print(f"Unmap Error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/outcomes/{account_id}/tree")
async def get_tree(account_id: int):
    tree_data = canvas.get_hierarchy_tree(account_id)
    if not tree_data:
        # If the tree failed, return a 404 instead of letting FastAPI crash with a 500
        raise HTTPException(
            status_code=404, detail="Hierarchy not found or access denied"
        )
    return {"status": "success", "tree": tree_data}


import threading
import queue


@app.get("/outcomes/{account_id}/stream")
async def stream_tree(account_id: int):
    msg_queue = queue.Queue()

    def generate():
        # Initial heartbeat
        yield f"data: {json.dumps({'status': 'info', 'msg': 'Connecting to Canvas...'})}\n\n"

        # The observer now just puts strings into the queue
        def observer(msg):
            msg_queue.put(msg)

        # Run the crawl in a background thread so it doesn't block the generator
        def run_crawl():
            try:
                tree = canvas.get_hierarchy_tree(account_id, observer=observer)
                msg_queue.put(("COMPLETE", tree))
            except Exception as e:
                msg_queue.put(("ERROR", str(e)))

        thread = threading.Thread(target=run_crawl)
        thread.start()

        # While the thread is running (or queue has messages), yield them
        while True:
            try:
                msg = msg_queue.get(timeout=30)  # Wait for a message
                if isinstance(msg, tuple):
                    status, data = msg
                    if status == "COMPLETE":
                        yield f"data: {json.dumps({'status': 'complete', 'tree': data})}\n\n"
                        break
                    if status == "ERROR":
                        yield f"data: {json.dumps({'status': 'error', 'msg': data})}\n\n"
                        break
                else:
                    # Regular progress message
                    yield f"data: {json.dumps({'status': 'info', 'msg': msg})}\n\n"
            except queue.Empty:
                # Keep-alive heartbeat if Canvas is taking forever
                yield f"data: {json.dumps({'status': 'info', 'msg': 'Still working...'})}\n\n"

    return StreamingResponse(generate(), media_type="text/event-stream")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8000)
