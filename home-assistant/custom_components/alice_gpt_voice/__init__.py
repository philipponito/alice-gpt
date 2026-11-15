"""Deliver deferred Alice GPT results without repeating any user action."""
import asyncio
import logging
from datetime import timedelta

from aiohttp import ClientError, ClientTimeout
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.event import async_track_time_interval

from .const import DOMAIN, ORIGIN
from .delivery import speech

_LOGGER = logging.getLogger(__name__)


async def async_setup_entry(hass, entry):
    session = async_get_clientsession(hass)
    lock = asyncio.Lock()
    last_id = None
    disabled = False

    async def poll(_now):
        nonlocal last_id, disabled
        if disabled or lock.locked():
            return
        state = hass.states.get(entry.data["entity_id"])
        # Never fall back to truncated cloud TTS or announce on a guessed device.
        if not state or state.state in ("unknown", "unavailable") or "alice_state" not in state.attributes:
            return
        async with lock:
            try:
                async with session.post(
                    f"{ORIGIN}/api/bridge/next",
                    headers={"Authorization": f"Bearer {entry.data['token']}"},
                    allow_redirects=False,
                    timeout=ClientTimeout(total=8),
                ) as response:
                    if response.status == 403:
                        disabled = True
                        _LOGGER.warning("Bridge authorization expired or was revoked; reconnect the integration")
                        return
                    if response.status != 200:
                        return
                    item = speech(await response.json())
                if item is None or item[0] == last_id:
                    return
                last_id, text = item
                # The server already claimed the delivery. Never retry a failed
                # speech call: an ambiguous failure could otherwise speak twice.
                await hass.services.async_call(
                    "media_player", "play_media",
                    {"entity_id": entry.data["entity_id"],
                     "media_content_id": text, "media_content_type": "text"},
                    blocking=True,
                )
            except (ClientError, TimeoutError, ValueError):
                # Do not log URLs, tokens, Google answers or provider exceptions.
                return
            except Exception:
                _LOGGER.warning("Could not deliver a deferred answer; manual retrieval remains available")

    entry.async_on_unload(async_track_time_interval(hass, poll, timedelta(seconds=10)))
    return True


async def async_unload_entry(hass, entry):
    return True
