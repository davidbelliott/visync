# visync

## Overview

`visync` is a platform for displaying visuals that react to music. It consists of two components, a JavaScript frontend that runs in the browser and is built with THREE.js, and a backend that is written in Python, runs on a Raspberry Pi, and translates MIDI messages to websockets messages which are sent to the frontend.

## Code Organization

### Frontend

The JavaScript frontend is located in the directory `web` and built with Vite. The `web` directory contains:

* `main.js`: main entry point for the application
* `src`: other JavaScript source files
* `glsl`: GLSL shader source files
* `stl`: STL model exports used by the application
* `models`: OpenSCAD or Blender models used to export STLs
* `img`: Images that may be used by the web app
* `font`: Web fonts
* `dist`: Not tracked in version control. Directory for compiled web application.

### Backend

The Python backend is located in the directory `adapter`. The `adapter` directory contains:

* `adapter.py`: main entry point for the backend
* `*.py`: other Python source files
* `start-server`: script to start the server, called by the systemd service on the Pi
* `setup-server`: script to setup the Python environment and requirements for the server on the Pi

## How To Run for Local Development

Development of the frontend can be done on a single computer with no need for external hardware. First, ensure the following prerequisites are installed:

* npm
* Vite
* Python (tested on 3.13)

To install all Node dependencies, run `npm -i`. Then, to host a development server and watch for changes by running `./web/watch.sh`.

To setup the virtual environment for `adapter.py`, use uv or pip to set up a virtual environment in `adapter/.venv` (start-server and setup-server will expect this directory to be used). Then run `uv pip install -r requirements.txt` or `pip install -r requirements.txt`.

The backend, `adapter.py`, may be used to generate a fake beat sequence for testing purposes. Use the `--fake <bpm>` flag. For more flags, run `adapter.py --help`.
