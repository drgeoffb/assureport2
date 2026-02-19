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

    def get_account_details(self, account_id: int):
        url = f"{self.base_url}/accounts/{account_id}"
        return requests.get(url, headers=self.headers).json()

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

    def _format_outcome_node(self, o):
        if not o or not isinstance(o, dict) or "id" not in o:
            return None

        o_id = o.get("id")
        ref_code = o.get("title") or ""
        display_name = o.get("display_name") or ref_code or f"ID: {o_id}"

        # Clean description: Take only the part before the <hr>
        full_desc = o.get("description") or ""
        clean_desc = full_desc.split("<hr>")[0] if "<hr>" in full_desc else full_desc

        # Process GUID (Anti-Self Filter)
        guid = o.get("vendor_guid") or ""
        raw_vals = guid.replace("MAPPED_TO:", "").split(",")
        p_ids = []
        for val in raw_vals:
            v = val.strip()
            if v and v != str(o_id) and v != ref_code:
                p_ids.append(v)

        return {
            "id": o_id,
            "ref_code": ref_code,
            "display_name": display_name,
            "description": clean_desc.strip(),
            "type": "outcome",
            "is_mapped": len(p_ids) > 0,
            "parent_ids": p_ids,
        }

    def _paginate(self, url, silent=False):
        if not url:
            return []
        try:
            results = []
            while url:
                resp = requests.get(url, headers=self.headers)
                if resp.status_code != 200:
                    if not silent:
                        print(f"⚠️ API Error {resp.status_code} on {url}")
                    break
                data = resp.json()
                if isinstance(data, list):
                    results.extend(data)
                url = resp.links.get("next", {}).get("url")
            return results
        except Exception:
            return []

    def _deduplicate_children(self, children):
        seen_ids = set()
        unique_children = []
        for c in children:
            key = f"{c['type']}_{c['id']}"
            if key not in seen_ids:
                seen_ids.add(key)
                unique_children.append(c)
        return unique_children

    def get_hierarchy_tree(self, account_id, observer=None):
        acc_info = self.get_account_details(account_id)
        acc_name = acc_info.get("name", f"Account {account_id}")

        if observer:
            observer(f"Accessing Account: {acc_name}")

        node = {
            "id": account_id,
            "name": acc_name,
            "type": "folder",
            "is_account": True,
            "children": [],
        }

        # 1. Sub-Accounts
        subs = self._paginate(f"{self.base_url}/accounts/{account_id}/sub_accounts")
        for sub in subs:
            node["children"].append(self.get_hierarchy_tree(sub["id"], observer))

        # 2. Outcome Groups
        groups = self._paginate(f"{self.base_url}/accounts/{account_id}/outcome_groups")
        for g in groups:
            # Recursively get contents
            group_contents = self._get_nested_group_contents(
                account_id, g["id"], g["title"], observer
            )

            if g.get("vendor_guid") == "ROOT" or g.get("title") == acc_name:
                node["children"].extend(group_contents)
            else:
                node["children"].append(
                    {
                        "id": g["id"],
                        "name": g["title"],
                        "type": "folder",
                        "is_account": False,
                        "children": group_contents,
                    }
                )

        node["children"] = self._deduplicate_children(node["children"])
        node["children"].sort(
            key=lambda x: (
                x["type"] != "folder",
                x.get("name", x.get("display_name", "")).lower(),
            )
        )
        return node

    def _get_nested_group_contents(
        self, account_id: int, group_id: int, group_title: str, observer=None
    ):
        children = []  # Correctly initialized here

        # ADDED: outcome_style=full to get descriptions
        outcomes_url = f"{self.base_url}/accounts/{account_id}/outcome_groups/{group_id}/outcomes?outcome_style=full"
        outcome_links = self._paginate(outcomes_url, silent=True)

        if not outcome_links:
            outcome_links = self._paginate(
                f"{self.base_url}/outcome_groups/{group_id}/outcomes?outcome_style=full",
                silent=True,
            )

        if observer:
            observer(f"Loading {len(outcome_links)} items in {group_title}")

        for link in outcome_links:
            o = link.get("outcome", link)
            formatted = self._format_outcome_node(o)
            if formatted:
                children.append(formatted)

        # B. Get Subgroups
        subgroups_url = (
            f"{self.base_url}/accounts/{account_id}/outcome_groups/{group_id}/subgroups"
        )
        subgroups = self._paginate(subgroups_url, silent=True)

        for sg in subgroups:
            children.append(
                {
                    "id": sg["id"],
                    "name": sg["title"],
                    "type": "folder",
                    "is_account": False,
                    "children": self._get_nested_group_contents(
                        account_id, sg["id"], sg["title"], observer
                    ),
                }
            )

        return children
