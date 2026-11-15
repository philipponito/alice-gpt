"""Bind one explicitly selected local Yandex speaker to an Alice user."""
from aiohttp import ClientError, ClientTimeout
import voluptuous as vol

from homeassistant.config_entries import ConfigFlow
from homeassistant.helpers import selector
from homeassistant.helpers.aiohttp_client import async_get_clientsession

from .const import DOMAIN, ORIGIN


class VoiceConfigFlow(ConfigFlow, domain=DOMAIN):
    VERSION = 1

    async def async_step_user(self, user_input=None):
        if self._async_current_entries():
            return self.async_abort(reason="already_configured")
        errors = {}
        if user_input:
            state = self.hass.states.get(user_input["entity_id"])
            if not state or "alice_state" not in state.attributes:
                errors["base"] = "not_local"
            else:
                try:
                    session = async_get_clientsession(self.hass)
                    async with session.post(
                        f"{ORIGIN}/api/bridge/pair",
                        json={"code": user_input["code"], "secret": user_input["secret"]},
                        allow_redirects=False, timeout=ClientTimeout(total=10),
                    ) as response:
                        if response.status == 200:
                            data = await response.json()
                            return self.async_create_entry(
                                title="Мой GPT — Станция",
                                data={"token": data["token"], "entity_id": user_input["entity_id"]},
                            )
                        errors["base"] = "pairing_denied"
                except (ClientError, TimeoutError, ValueError, KeyError):
                    errors["base"] = "cannot_connect"
        return self.async_show_form(
            step_id="user", errors=errors,
            data_schema=vol.Schema({
                vol.Required("entity_id"): selector.EntitySelector(
                    selector.EntitySelectorConfig(domain="media_player", integration="yandex_station")
                ),
                vol.Required("code"): selector.TextSelector(),
                vol.Required("secret"): selector.TextSelector(
                    selector.TextSelectorConfig(type=selector.TextSelectorType.PASSWORD)
                ),
            }),
        )
