import importlib.util
import pathlib
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch

path = pathlib.Path(__file__).parent / "custom_components/alice_gpt_voice/home.py"
spec = importlib.util.spec_from_file_location("home_actions", path)
home = importlib.util.module_from_spec(spec)
spec.loader.exec_module(home)


class HomeTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.state = "off"
        self.calls = []

        async def execute(domain, service, data, blocking):
            self.calls.append((domain, service, data, blocking))
            self.state = "on" if service == "turn_on" else "off"

        self.hass = SimpleNamespace(
            states=SimpleNamespace(get=lambda _: SimpleNamespace(state=self.state)),
            services=SimpleNamespace(async_call=execute))
        self.item = {"kind": "home_action", "id": "a" * 43, "target": "room_light", "action": "on"}

    async def test_executes_only_mapped_light_and_checks_state(self):
        result = await home.apply_light(self.hass, self.item)
        self.assertEqual(result["state"], "on")
        self.assertEqual(self.calls, [("light", "turn_on", {"entity_id": "light.komnata_na_tretem_rozetka"}, True)])

    async def test_rejects_other_devices_services_and_bad_ids(self):
        for changes in ({"target": "computer"}, {"target": "switch.komnata_na_tretem_plitka"},
                        {"action": "toggle"}, {"id": "bad"}, {"target": []}):
            self.assertIsNone(await home.apply_light(self.hass, {**self.item, **changes}))
        self.assertEqual(self.calls, [])

    async def test_unavailable_device_is_not_switched(self):
        self.state = "unavailable"
        self.assertEqual((await home.apply_light(self.hass, self.item))["state"], "unknown")
        self.assertEqual(self.calls, [])

    async def test_successful_service_call_without_matching_state_is_not_success(self):
        self.hass.services.async_call = AsyncMock()
        with patch.object(home.asyncio, "sleep", new=AsyncMock()):
            self.assertEqual((await home.apply_light(self.hass, self.item))["state"], "unknown")
        self.hass.services.async_call.assert_awaited_once()

    async def test_failed_service_is_never_retried(self):
        self.hass.services.async_call = AsyncMock(side_effect=RuntimeError("synthetic failure"))
        self.assertEqual((await home.apply_light(self.hass, self.item))["state"], "error")
        self.hass.services.async_call.assert_awaited_once()


if __name__ == "__main__":
    unittest.main()
