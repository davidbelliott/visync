import asyncio
import pathlib
import json
import websockets

WS_PORT = 8765
MSG_TYPE_PROMOTION = 4

# Set of connected viewer clients
connected = set()

# Connected adapter client
adapter = None
adapter_secret = None

async def echo(websocket):
    global adapter
    global adapter_secret
    # Register new client
    connected.add(websocket)
    print("Client connected")
    try:
        async for message in websocket:
            # Decode the message to check if it is a promotion request
            data = json.loads(message)
            if int(data["msg_type"]) == MSG_TYPE_PROMOTION \
                    and adapter_secret != None \
                    and data["secret"] == adapter_secret:
                print("Adapter registered")
                # Register the adapter client
                adapter = websocket
                connected.remove(websocket)
            elif adapter == websocket:
                # Echo the message to all connected clients
                websockets.broadcast(connected, message)
            else:
                print(message)
                # Send the message to the adapter
                #await adapter.send(message)
    finally:
        if adapter == websocket:
            print("Adapter disconnected")
            adapter = None
        else:
            # Unregister client
            print("Client disconnected")
            connected.remove(websocket)


async def main():
    global adapter_secret
    # Get secret for adapter to connect
    this_dir = pathlib.Path(__file__).parent.resolve()
    with open(this_dir / "secret.txt", "r") as f:
        adapter_secret = f.read().strip()

    async with websockets.serve(echo, "0.0.0.0", WS_PORT):
        await asyncio.Future()  # run forever


if __name__ == "__main__":
    asyncio.run(main())
