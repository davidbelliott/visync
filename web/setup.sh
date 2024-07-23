#!/bin/sh

# Configure nginx to host the static pages, and build + deploy the current
# working version of the site to nginx's html directory

sudo cp visync.nginx.conf /etc/nginx/sites-available/
sudo ln -sf /etc/nginx/sites-available/visync.nginx.conf \
    /etc/nginx/sites-enabled/
./deploy.sh
