#!/usr/bin/env python3
import asyncio
import re
from aiohttp import web

from aiortc import RTCPeerConnection, RTCSessionDescription, VideoStreamTrack
from aiortc.contrib.media import MediaPlayer, MediaRelay
from av import VideoFrame

from picamera2 import Picamera2


# -----------------------------
# Camera init (Picamera2)
# -----------------------------
picam2 = Picamera2()
config = picam2.create_video_configuration(
    main={"size": (1280, 720), "format": "RGB888"}
)
picam2.configure(config)
picam2.start()


class CameraStreamTrack(VideoStreamTrack):
    """
    WebRTC video track reading frames from Picamera2.
    """
    async def recv(self):
        pts, time_base = await self.next_timestamp()

        rgb = picam2.capture_array()  # RGB888 ndarray
        frame = VideoFrame.from_ndarray(rgb, format="rgb24")
        frame.pts = pts
        frame.time_base = time_base
        return frame


# -----------------------------
# Audio init (iPhone-safe)
# -----------------------------
AUDIO_DEVICE = "plughw:1,0"  # USB mic card 1, device 0

relay = MediaRelay()

audio_player = MediaPlayer(
    AUDIO_DEVICE,
    format="alsa",
    options={
        # Force MONO for best iOS compatibility
        "channels": "1",
        "sample_rate": "48000",

        # Smooth clock drift / avoid "brrrr"
        # (ffmpeg filter; works well for WebRTC capture)
        "af": "aresample=async=1:min_hard_comp=0.100:first_pts=0",
    },
)


# -----------------------------
# PiSugar v3 TCP helper (optional)
# -----------------------------
async def _pisugar_cmd(cmd: str) -> str:
    reader, writer = await asyncio.open_connection("127.0.0.1", 8423)
    writer.write((cmd.strip() + "\n").encode("utf-8"))
    await writer.drain()
    data = await reader.read(4096)
    writer.close()
    await writer.wait_closed()
    return data.decode("utf-8", errors="ignore").strip()


def _parse_number(line: str):
    m = re.search(r":\s*([0-9]+(?:\.[0-9]+)?)", line)
    return float(m.group(1)) if m else None


def _parse_bool(line: str):
    m = re.search(r":\s*(true|false)", line, re.I)
    return (m.group(1).lower() == "true") if m else None


async def pisugar_json(request):
    try:
        batt_line = await _pisugar_cmd("get battery")
        plug_line = await _pisugar_cmd("get battery_power_plugged")
        allow_line = await _pisugar_cmd("get battery_allow_charging")

        battery = _parse_number(batt_line)
        plugged = _parse_bool(plug_line)
        allow = _parse_bool(allow_line)
        charging = bool(plugged and allow)

        return web.json_response(
            {"battery": battery, "plugged": plugged, "allow_charging": allow, "charging": charging}
        )
    except Exception as e:
        return web.json_response({"error": str(e)}, status=503)


# -----------------------------
# Web app routes
# -----------------------------
pcs = set()


async def index(request):
    with open("index.html", "r", encoding="utf-8") as f:
        return web.Response(content_type="text/html", text=f.read())


async def offer(request):
    params = await request.json()
    offer = RTCSessionDescription(sdp=params["sdp"], type=params["type"])

    pc = RTCPeerConnection()
    pcs.add(pc)

    @pc.on("connectionstatechange")
    async def on_connectionstatechange():
        if pc.connectionState in ("failed", "closed", "disconnected"):
            await pc.close()
            pcs.discard(pc)

    # IMPORTANT: set remote description first
    await pc.setRemoteDescription(offer)

    # Video: only if client offered video
    has_video = any(t.kind == "video" for t in pc.getTransceivers())
    if has_video:
        pc.addTrack(CameraStreamTrack())

    # Audio: relay (reliable for multiple clients)
    has_audio = any(t.kind == "audio" for t in pc.getTransceivers())
    print("has_audio:", has_audio, "audio_player.audio is None:", audio_player.audio is None)

    if has_audio and audio_player.audio:
        pc.addTrack(relay.subscribe(audio_player.audio))

    answer = await pc.createAnswer()
    await pc.setLocalDescription(answer)

    return web.json_response({"sdp": pc.localDescription.sdp, "type": pc.localDescription.type})


async def on_shutdown(app):
    coros = [pc.close() for pc in pcs]
    await asyncio.gather(*coros, return_exceptions=True)
    pcs.clear()


# -----------------------------
# App setup
# -----------------------------
app = web.Application()
app.on_shutdown.append(on_shutdown)

app.router.add_get("/", index)
app.router.add_post("/offer", offer)
app.router.add_get("/pisugar.json", pisugar_json)
app.router.add_static("/static/", path="static", name="static")


if __name__ == "__main__":
    # Use 127.0.0.1 if behind Caddy, otherwise 0.0.0.0 for LAN access
    web.run_app(app, host="0.0.0.0", port=8080)
