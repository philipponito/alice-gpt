"""Only two explicitly configured lights; never arbitrary services or sockets."""
import asyncio
import re

LIGHTS = {
    "room_light": "light.komnata_na_tretem_rozetka",
    "kitchen_light": "light.kukhnia_lampa_kukhonnaia",
}


async def apply_light(hass, item):
    if not isinstance(item, dict) or item.get("kind") != "home_action":
        return None
    job, target, action = item.get("id"), item.get("target"), item.get("action")
    if not isinstance(job, str) or not re.fullmatch(r"[\w-]{43}", job):
        return None
    if not isinstance(target, str) or target not in LIGHTS or action not in ("on", "off"):
        return None
    entity_id = LIGHTS[target]
    state = hass.states.get(entity_id)
    if not state or state.state in ("unknown", "unavailable"):
        return {"id": job, "state": "unknown"}
    try:
        await asyncio.wait_for(hass.services.async_call(
            "light", "turn_" + action, {"entity_id": entity_id}, blocking=True), timeout=6)
        for attempt in range(16):
            current = hass.states.get(entity_id)
            if current and current.state == action:
                return {"id": job, "state": action}
            if attempt < 15:
                await asyncio.sleep(0.2)
        return {"id": job, "state": "unknown"}
    except Exception:
        # Never log device/provider details; never repeat an ambiguous action.
        return {"id": job, "state": "error"}
