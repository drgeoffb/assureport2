import requests
import os
import re
from dotenv import load_dotenv

load_dotenv()

class CanvasClient:
    def __init__(self):
        self.domain = os.getenv("CANVAS_DOMAIN")
        self.token = os.getenv("CANVAS_TOKEN")
        self.headers = {"Authorization": f"Bearer {self.token}"}
        self.base_url = f"https://{self.domain}/api/v1"

    def get_outcome_details(self, outcome_id: int):
        url = f"{self.base_url}/outcomes/{outcome_id}"
        res = requests.get(url, headers=self.headers)
        if res.status_code != 200:
            raise Exception(f"Outcome {outcome_id} not found in Canvas.")
        return res.json()

    def update_outcome(self, outcome_id: int, guid: str, description: str):
        url = f"{self.base_url}/outcomes/{outcome_id}"
        payload = {"vendor_guid": guid, "description": description}
        res = requests.put(url, headers=self.headers, json=payload)
        return res.json()

    def get_all_outcomes(self, account_id: int):
        url = f"{self.base_url}/accounts/{account_id}/outcome_group_links"
        all_data = self._paginate(url)
        mapped, orphans = [], []

        for item in all_data:
            outcome = item.get("outcome", {})
            guid = outcome.get("vendor_guid", "")
            if guid and "MAPPED_TO:" in guid:
                mapped.append({"id": outcome["id"], "title": outcome["title"], "guid": guid})
            else:
                orphans.append({"id": outcome["id"], "title": outcome["title"]})
        return {"mapped": mapped, "orphans": orphans}
    
    def get_all_outcomes_recursive(self, account_id: int):
        """Recursively collects outcomes from an account and all its children."""
        print(f"🔍 Accessing Account: {account_id}")
        all_data = {"mapped": [], "orphans": []}
        
        # 1. Get Account Name for the UI labels
        acc_info = self.get_account_details(account_id)
        acc_name = acc_info.get("name", f"Account {account_id}")

        # 2. Get outcomes linked to THIS account
        url = f"{self.base_url}/accounts/{account_id}/outcome_group_links"
        current_links = self._paginate(url)
        
        for item in current_links:
            outcome = item.get("outcome", {})
            guid = outcome.get("vendor_guid", "")
            
            outcome_entry = {
                "id": outcome.get("id"),
                "title": outcome.get("title"),
                "account_name": acc_name,
                "guid": guid
            }

            if guid and "MAPPED_TO:" in guid:
                all_data["mapped"].append(outcome_entry)
            else:
                all_data["orphans"].append(outcome_entry)

        # 3. Dig into Sub-Accounts
        sub_url = f"{self.base_url}/accounts/{account_id}/sub_accounts"
        subs = self._paginate(sub_url)
        
        for sub in subs:
            # Recursive call to the next level down
            sub_results = self.get_all_outcomes_recursive(sub["id"])
            all_data["mapped"].extend(sub_results["mapped"])
            all_data["orphans"].extend(sub_results["orphans"])
            
        return all_data
    
    def get_account_details(self, account_id: int):
        url = f"{self.base_url}/accounts/{account_id}"
        return requests.get(url, headers=self.headers).json()

    def search_outcomes_recursive(self, account_id: int, query: str):
            """Recursively searches for outcomes matching a query string."""
            results = []
            query = query.lower()

            # 1. Get outcomes for this account level
            url = f"{self.base_url}/accounts/{account_id}/outcome_group_links"
            links = self._paginate(url)
            
            acc_info = self.get_account_details(account_id)
            acc_name = acc_info.get("name", "Unknown Account")

            for item in links:
                outcome = item.get("outcome", {})
                title = outcome.get("title", "")
                if query in title.lower():
                    results.append({
                        "id": outcome.get("id"),
                        "title": title,
                        "account_name": acc_name
                    })

            # 2. Search Sub-Accounts
            sub_url = f"{self.base_url}/accounts/{account_id}/sub_accounts"
            subs = self._paginate(sub_url)
            for sub in subs:
                results.extend(self.search_outcomes_recursive(sub["id"], query))
                
            return results
    
    def map_outcome_multi(self, outcome_id: int, parent_id: int, parent_title: str):
        """Adds a parent link to an outcome without overwriting existing links."""
        # 1. Get current state
        outcome = self.get_outcome_details(outcome_id)
        current_guid = outcome.get('vendor_guid', "")
        current_desc = outcome.get('description', "")

        # 2. Handle the GUID (The 'Database' layer)
        ids = []
        if "MAPPED_TO:" in current_guid:
            ids = current_guid.replace("MAPPED_TO:", "").split(",")
        
        if str(parent_id) not in ids:
            ids.append(str(parent_id))
        
        new_guid = f"MAPPED_TO:{','.join(ids)}"

        # 3. Handle the Description (The 'Visual' layer)
        # Strip old mapping text if it exists to rebuild it cleanly
        base_description = current_desc.split("<hr>")[0]
        
        # Build the new footer
        # Note: In a production version, you'd fetch all parent titles.
        # For now, we append the new one to keep it lightweight.
        assurance_footer = f"<hr><p><b>Assurance Mapping:</b> This outcome aligns with:</p><ul>"
        
        if "<li>" in current_desc:
            # Extract existing list items and add the new one
            existing_items = re.findall(r"<li>(.*?)</li>", current_desc)
            if f"{parent_title} (ID: {parent_id})" not in existing_items:
                existing_items.append(f"{parent_title} (ID: {parent_id})")
            
            list_html = "".join([f"<li>{item}</li>" for item in existing_items])
            new_description = f"{base_description}{assurance_footer}{list_html}</ul>"
        else:
            new_description = f"{base_description}{assurance_footer}<li>{parent_title} (ID: {parent_id})</li></ul>"

        # 4. Push to Canvas
        return self.update_outcome(outcome_id, new_guid, new_description)

    def unmap_outcome_surgical(self, outcome_id: int, parent_id: int, parent_title: str):
        """Removes a specific parent link from the outcome."""
        outcome = self.get_outcome_details(outcome_id)
        current_guid = outcome.get('vendor_guid', "")
        current_desc = outcome.get('description', "")

        # 1. Update GUID
        ids = current_guid.replace("MAPPED_TO:", "").split(",") if "MAPPED_TO:" in current_guid else []
        if str(parent_id) in ids:
            ids.remove(str(parent_id))
        
        new_guid = f"MAPPED_TO:{','.join(ids)}" if ids else ""

        # 2. Update Description
        if not ids:
            new_description = current_desc.split("<hr>")[0]
        else:
            # Remove the specific list item for this parent
            target_li = f"<li>{parent_title} (ID: {parent_id})</li>"
            new_description = current_desc.replace(target_li, "")
            # If no items left in list, clean up the whole footer
            if "<li>" not in new_description:
                new_description = new_description.split("<hr>")[0]

        return self.update_outcome(outcome_id, new_guid, new_description)
   

    def _get_group_contents(self, group_id: int):
        # If the group ID is 0 or invalid, return empty immediately
        if not group_id: return []
        
        # Updated URL to the more reliable "links" endpoint for groups
        url = f"{self.base_url}/outcome_groups/{group_id}/outcomes"
        items = self._paginate(url)
        
        if not items: return []
        
        nodes = []
        for i in items:
            # Check if it's a nested dictionary or direct object
            o = i.get("outcome", i) 
            formatted = self._format_outcome_node(o)
            if formatted:
                nodes.append(formatted)
        return nodes

    def _get_group_contents(self, group_id: int):
        # Helper to get outcomes inside a specific Canvas folder
        url = f"{self.base_url}/outcome_groups/{group_id}/outcomes"
        items = self._paginate(url)
        return [self._format_outcome_node(i.get("outcome", {})) for i in items]

    def _paginate(self, url, silent=False):
        if not url: return []
        try:
            results = []
            while url:
                resp = requests.get(url, headers=self.headers)
                if resp.status_code != 200:
                    if not silent:
                        print(f"   ⚠️ API Error {resp.status_code} on {url}")
                    break
                
                data = resp.json()
                if isinstance(data, list):
                    results.extend(data)
                url = resp.links.get('next', {}).get('url')
            return results
        except Exception:
            return []        
        
def _format_outcome_node(self, o):
    if not o or not isinstance(o, dict) or 'id' not in o:
        return None
    
    o_id = o.get("id")
    # Reference Code (Title) and Human Label (Display Name)
    ref_code = o.get("title") or "" 
    display_name = o.get("display_name") or ref_code or f"ID: {o_id}"
    
    # Description Handling: Only take the part before the <hr> mapping data
    full_desc = o.get("description") or ""
    clean_desc = full_desc.split("<hr>")[0] if "<hr>" in full_desc else full_desc
    
    guid = o.get("vendor_guid") or ""
    p_ids = [pid for pid in guid.replace("MAPPED_TO:", "").split(",") if pid and pid != str(o_id)]
    
    return {
        "id": o_id, 
        "ref_code": ref_code,      # e.g., "AQF7_01_K"
        "display_name": display_name, # e.g., "AQF7 01 K Body of Knowledge"
        "description": clean_desc,    # Text before <hr>
        "type": "outcome",
        "is_mapped": len(p_ids) > 0, 
        "parent_ids": p_ids
    }
    
    def _deduplicate_children(self, children):
        seen_ids = set()
        unique_children = []
        for c in children:
            # Create a unique key based on type and ID
            key = f"{c['type']}_{c['id']}"
            if key not in seen_ids:
                seen_ids.add(key)
                unique_children.append(c)
        return unique_children
    
    def get_hierarchy_tree(self, account_id, observer=None):
        acc_info = self.get_account_details(account_id)
        acc_name = acc_info.get("name", "")

        if observer:
                # This message travels all the way to the 'loading-text' span
                observer(f"Accessing Account: {acc_name}")        
                
        node = {
            "id": account_id,
            "name": acc_name,
            "type": "folder",
            "is_account": True,
            "children": []
        }

        # 1. Sub-Accounts
        subs = self._paginate(f"{self.base_url}/accounts/{account_id}/sub_accounts")
        for sub in subs:
            node["children"].append(self.get_hierarchy_tree(sub["id"]))

        # 2. Outcome Groups - Contextualized to this Account
        groups_url = f"{self.base_url}/accounts/{account_id}/outcome_groups"
        groups = self._paginate(groups_url)
        
        # Inside get_hierarchy_tree loop for groups:
        for g in groups:
            if g.get("vendor_guid") == "ROOT" or g.get("title") == acc_name:
                # Pass account_id, group_id, group_title, and observer
                node["children"].extend(self._get_nested_group_contents(account_id, g["id"], g["title"], observer))
            else:
                node["children"].append({
                    "id": g["id"],
                    "name": g["title"],
                    "type": "folder",
                    "is_account": False,
                    "children": self._get_nested_group_contents(account_id, g["id"], g["title"], observer)
                })

        node["children"] = self._deduplicate_children(node["children"])
        node["children"].sort(key=lambda x: (x['type'] != 'folder', x['name'].lower()))
        return node

    def _get_nested_group_contents(self, account_id: int, group_id: int, group_title: str, observer=None):
        """Deep crawl with granular progress reporting."""
        children = []

        # A. Get Outcomes
        outcomes_url = f"{self.base_url}/accounts/{account_id}/outcome_groups/{group_id}/outcomes"
        outcome_links = self._paginate(outcomes_url, silent=True)
        
        if not outcome_links:
            outcome_links = self._paginate(f"{self.base_url}/outcome_groups/{group_id}/outcomes", silent=True)

        if observer:
            observer(f"Got {len(outcome_links)} outcomes for {group_title}")

        for link in outcome_links:
            o = link.get("outcome")
            formatted = self._format_outcome_node(o)
            if formatted:
                children.append(formatted)

        # B. Get Subgroups
        subgroups_url = f"{self.base_url}/accounts/{account_id}/outcome_groups/{group_id}/subgroups"
        subgroups = self._paginate(subgroups_url, silent=True)
        
        if not subgroups:
            subgroups = self._paginate(f"{self.base_url}/outcome_groups/{group_id}/subgroups", silent=True)

        for sg in subgroups:
            # Pass the observer down to the next level of recursion
            children.append({
                "id": sg["id"],
                "name": sg["title"],
                "type": "folder",
                "is_account": False,
                "children": self._get_nested_group_contents(account_id, sg["id"], sg["title"], observer)
            })

        return children
    
        
    def get_course_outcomes(self, course_id, observer=None):
        """
        New helper to grab SLOs and ALOs from a specific Canvas Course.
        """
        if observer:
            observer(f"Diving into Course {course_id} for SLOs/ALOs...")
            
        # In Canvas, Course outcomes are accessed via:
        # /api/v1/courses/:course_id/outcome_group_links
        # ... logic similar to your account crawler ...