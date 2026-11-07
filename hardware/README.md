# Inklink hardware: ESP32-S3 status display

Open-source firmware for the shop's ESP32-S3 display, published here so the hardware side is inspectable too. It is a **standalone Arduino sketch** in [`inklink_display/`](inklink_display/). Nothing else in this repository builds, imports or depends on it.

## What it is

An OLED status display with four buttons, three LEDs and a buzzer. It shows job and payment status that it reads from an Inklink backend over HTTPS.

It is not a PDF renderer, a print gateway or a printer driver. It does not start or verify payments, authorize printing, or invent transaction IDs. It only displays what the backend returns.

## What the sketch does

1. Joins Wi-Fi, syncs the clock (SNTP) and checks `GET /health`.
2. Sends a heartbeat to `/api/v1/devices/heartbeat` every 20 s.
3. Polls `/api/v1/devices/display?deviceId=...` every 3 s and renders the result on six OLED pages.
4. Uses HTTPS with a pinned root certificate (`gts_root_r1.h`, Google Trust Services GTS Root R1) and a bearer device token.

## Hardware

| Part | Pin |
|---|---|
| Confirm / Cancel / Next / Previous buttons | GPIO 4 / 5 / 6 / 7 (to GND, internal pull-up) |
| SSD1306 OLED 128x64, I2C `0x3C` | SDA GPIO 8, SCL GPIO 9 |
| LEDs ready / process / error | GPIO 10 / 11 / 12 |
| Buzzer | GPIO 13 |

## Build

Arduino IDE or `arduino-cli` with the **esp32 by Espressif** package, board **ESP32S3 Dev Module**. Libraries: **Adafruit GFX**, **Adafruit SSD1306**, **ArduinoJson 6.x**.

```text
cd hardware/inklink_display
copy secrets.example.h secrets.h     # set DEVICE_TOKEN; secrets.h is git-ignored
# edit config.h for your Wi-Fi, backend URL, shop id and device id
```

Open `inklink_display.ino`, select the board and port, and upload. Serial runs at 115200.

## Status

- Source only. It has **not been compiled in CI**, and I have not run it on a real ESP32-S3 or in the simulator.
- The Cancel button is read but unused.
- `config.h` ships with the Cirkit simulator Wi-Fi (`CirkitWifi`, open) and the project's public backend URL.
- `gts_root_r1.h` was checked against the hosted backend's certificate chain, which ends at GTS Root R1. If you point the sketch at another host, replace it with that host's root.

## Security

- The device token is never committed. `secrets.h` is git-ignored; only `secrets.example.h` is in the repo. If a real token was ever shared, rotate it.
- All devices share one token. Per-device tokens are not built.
- The sketch prints backend responses to the serial port for debugging.
