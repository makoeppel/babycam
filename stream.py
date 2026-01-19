import asyncio
from aiohttp import web
from aiortc import RTCPeerConnection, RTCSessionDescription, VideoStreamTrack
from av import VideoFrame
from picamera2 import Picamera2

# ---- Camera init ----
picam2 = Picamera2()
config = picam2.create_video_configuration(main={"size": (640, 360), "format": "RGB888"})
picam2.configure(config)
picam2.start()

# Keep peer connections alive
pcs = set()

class CameraStreamTrack(VideoStreamTrack):
    """
    A VideoStreamTrack that pulls frames from Picamera2 and returns av.VideoFrame.
    """
    async def recv(self):
        # pacing / timestamps for WebRTC
        pts, time_base = await self.next_timestamp()

        # Picamera2 gives RGB888 as (H,W,3) uint8
        rgb = picam2.capture_array()

        frame = VideoFrame.from_ndarray(rgb, format="rgb24")
        frame.pts = pts
        frame.time_base = time_base
        return frame

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

    # IMPORTANT: set remote description FIRST (avoids offerDirection=None issues)
    await pc.setRemoteDescription(offer)

    # Only send video if the offer actually has a video m-line / transceiver
    has_video = any(t.kind == "video" for t in pc.getTransceivers())
    if has_video:
        pc.addTrack(CameraStreamTrack())

    answer = await pc.createAnswer()
    await pc.setLocalDescription(answer)

    return web.json_response({"sdp": pc.localDescription.sdp, "type": pc.localDescription.type})

async def on_shutdown(app):
    # Close all peer connections on shutdown
    coros = [pc.close() for pc in pcs]
    await asyncio.gather(*coros, return_exceptions=True)
    pcs.clear()

app = web.Application()
app.on_shutdown.append(on_shutdown)
app.router.add_get("/", index)
app.router.add_post("/offer", offer)

if __name__ == "__main__":
    web.run_app(app, host="0.0.0.0", port=8080)

