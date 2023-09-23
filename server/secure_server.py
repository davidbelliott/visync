import ssl
import asyncio
import pathlib
import ssl
import websockets

keyfile=pathlib.Path(__file__).parents[1] / "ssl" / "reuben.key"
certfile=pathlib.Path(__file__).parents[1] / "ssl" / "fullchain.pem"


async def hello(websocket, path):
    name = await websocket.recv()
    print(f"< {name}")

    greeting = f"Hello {name}!"

    await websocket.send(greeting)
    print(f"> {greeting}")

ssl_context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
ssl_context.load_cert_chain(certfile, keyfile)

start_server = websockets.serve(
    hello, "reuben", 8765, ssl=ssl_context
)
asyncio.get_event_loop().run_until_complete(start_server)
asyncio.get_event_loop().run_forever()
