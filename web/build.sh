#!/bin/sh

# Build the current working version of the site and place static files in the
# "dist" directory

cd "$(dirname "$0")"
npx vite build
for d in img stl glsl; do
	cp -r $d dist
done
