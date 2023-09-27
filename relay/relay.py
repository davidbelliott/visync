from websocket_server import WebsocketServer

WS_PORT=8765

def recv(client, server, msg):
    server.send_message_to_all(msg)


def main():
    server = WebsocketServer(host='', port=WS_PORT)
    server.set_fn_message_received(recv)
    server.run_forever()


if __name__ == "__main__":
    main()