#!/bin/sh
npx vite build
rm -rf rave
mv dist rave
for d in img stl glsl; do
	cp -r $d rave
done
sudo cp -r rave /usr/share/nginx/html/
