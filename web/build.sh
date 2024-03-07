#!/bin/sh
npx vite build
for d in img stl glsl; do
	cp -r $d dist
done
