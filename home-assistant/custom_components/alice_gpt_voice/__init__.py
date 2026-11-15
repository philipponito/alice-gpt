"""Deliver deferred Alice GPT results without repeating any user action."""
import asyncio
import logging
import time
from datetime import timedelta

from aiohttp import ClientError, ClientTimeout
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.event import async_track_time_interval

from .const import DOMAIN, ORIGIN
from .delivery import native_delivery, keepalive_allowed
from .home import apply_light

_LOGGER = logging.getLogger(__name__)


async def async_setup_entry(hass, entry):
    session = async_get_clientsession(hass)
    lock = asyncio.Lock()
    last_id = None
    seen_actions = set()
    previous_alice_state = None
    idle_since = 0
    disabled = False
    alive = True

    def stop():
        nonlocal alive
        alive = False

    entry.async_on_unload(stop)

    async def poll(_now):
        nonlocal last_id, disabled, previous_alice_state, idle_since
        if not alive or disabled or lock.locked():
            return
        state = hass.states.get(entry.data["entity_id"])
        # Never fall back to truncated cloud TTS or announce on a guessed device.
        if not state or state.state in ("unknown", "unavailable") or state.attributes.get("alice_state") is None:
            return
        ready = state.attributes.get("alice_state") == "IDLE"
        if ready and previous_alice_state != "IDLE":
            idle_since = time.monotonic()
        previous_alice_state = state.attributes.get("alice_state")
        keepalive_ready = keepalive_allowed(state, time.monotonic() - idle_since)
        async with lock:
            try:
                async with session.post(
                    f"{ORIGIN}/api/bridge/next",
                    headers={"Authorization": f"Bearer {entry.data['token']}"},
                    json={"lights": True, "ready": ready, "keepalive": True, "keepalive_ready": keepalive_ready},
                    allow_redirects=False,
                    timeout=ClientTimeout(total=8),
                ) as response:
                    if response.status == 403:
                        disabled = True
                        _LOGGER.warning("Bridge authorization expired or was revoked; reconnect the integration")
                        return
                    if response.status != 200:
                        return
                    data = await response.json()
                if isinstance(data, dict) and data.get("kind") == "home_action":
                    job = data.get("id")
                    if not isinstance(job, str) or job in seen_actions:
                        return
                    seen_actions.add(job)
                    if len(seen_actions) > 256:
                        seen_actions.clear()
                        seen_actions.add(job)
                    result = await apply_light(hass, data)
                    if result is not None:
                        async with session.post(
                            f"{ORIGIN}/api/bridge/home-result",
                            headers={"Authorization": f"Bearer {entry.data['token']}"},
                            json=result, allow_redirects=False, timeout=ClientTimeout(total=8),
                        ) as response:
                            if response.status == 403:
                                disabled = True
                    return
                pulse = isinstance(data, dict) and data.get("kind") == "keepalive"
                if pulse:
                    state = hass.states.get(entry.data["entity_id"])
                    if not keepalive_allowed(state, time.monotonic() - idle_since):
                        return
                    command = "Скажи навыку Мой GPT поддерживай связь"
                else:
                    item = native_delivery(data)
                    if item is None or item[0] == last_id:
                        return
                    last_id, command = item
                state = hass.states.get(entry.data["entity_id"])
                if not alive or not state or state.attributes.get("alice_state") != "IDLE":
                    return
                # The fixed command carries only a one-use reply identifier.
                # Alice gets the answer from our webhook and continues listening
                # inside the skill. Never execute model text as a command.
                # Do not retry after an ambiguous outcome; manual polling remains.
                await hass.services.async_call(
                    "media_player", "play_media",
                    {"entity_id": entry.data["entity_id"],
                     "media_content_id": command, "media_content_type": "command"},
                    blocking=True,
                )
            except (ClientError, TimeoutError, ValueError):
                # Do not log URLs, tokens, Google answers or provider exceptions.
                return
            except Exception:
                _LOGGER.warning("Could not deliver a deferred answer; manual retrieval remains available")

    entry.async_on_unload(async_track_time_interval(hass, poll, timedelta(seconds=5)))
    return True


async def async_unload_entry(hass, entry):
    return True
