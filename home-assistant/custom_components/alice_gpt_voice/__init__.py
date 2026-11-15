"""Deliver deferred Alice GPT results without repeating any user action."""
import asyncio
import logging
from datetime import timedelta

from aiohttp import ClientError, ClientTimeout
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.event import async_track_time_interval, async_track_state_change_event

from .const import DOMAIN, ORIGIN
from .delivery import speech, SpeechProgress

_LOGGER = logging.getLogger(__name__)


async def async_setup_entry(hass, entry):
    session = async_get_clientsession(hass)
    lock = asyncio.Lock()
    last_id = None
    disabled = False
    alive = True

    def stop():
        nonlocal alive
        alive = False

    entry.async_on_unload(stop)

    async def poll(_now):
        nonlocal last_id, disabled
        if not alive or disabled or lock.locked():
            return
        state = hass.states.get(entry.data["entity_id"])
        # Never fall back to truncated cloud TTS or announce on a guessed device.
        if not state or state.state in ("unknown", "unavailable") or state.attributes.get("alice_state") != "IDLE":
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
                state = hass.states.get(entry.data["entity_id"])
                if not alive or not state or state.attributes.get("alice_state") != "IDLE":
                    return
                # The server already claimed the delivery. Never retry a failed
                # speech call: an ambiguous failure could otherwise speak twice.
                progress = SpeechProgress()
                ended = asyncio.Event()

                def changed(event):
                    current = event.data.get("new_state")
                    value = current.attributes.get("alice_state") if current else None
                    if progress.feed(value) is not None:
                        ended.set()

                remove = async_track_state_change_event(hass, [entry.data["entity_id"]], changed)
                try:
                    await hass.services.async_call(
                        "media_player", "play_media",
                        {"entity_id": entry.data["entity_id"],
                         "media_content_id": text, "media_content_type": "text"},
                        blocking=True,
                    )
                    await asyncio.wait_for(ended.wait(), timeout=150)
                    if alive and progress.result == "done":
                        # Fixed app-owned command, never a model/tool supplied command.
                        await hass.services.async_call(
                            "media_player", "play_media",
                            {"entity_id": entry.data["entity_id"],
                             "media_content_id": "Запусти навык Мой GPT", "media_content_type": "command"},
                            blocking=True,
                        )
                finally:
                    remove()
            except (ClientError, TimeoutError, ValueError):
                # Do not log URLs, tokens, Google answers or provider exceptions.
                return
            except Exception:
                _LOGGER.warning("Could not deliver a deferred answer; manual retrieval remains available")

    entry.async_on_unload(async_track_time_interval(hass, poll, timedelta(seconds=10)))
    return True


async def async_unload_entry(hass, entry):
    return True
