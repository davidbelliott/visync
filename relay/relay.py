import asyncio
import websockets

WS_PORT = 8765

# Set of connected clients
connected = set()

async def echo(websocket):
    # Register new client
    connected.add(websocket)
    try:
        async for message in websocket:
            # Echo the message to all connected clients
            websockets.broadcast(connected, message)
    finally:
        # Unregister client
        connected.remove(websocket)


async def main():
    async with websockets.serve(echo, "0.0.0.0", WS_PORT):
        await asyncio.Future()  # run forever


if __name__ == "__main__":
    asyncio.run(main())
