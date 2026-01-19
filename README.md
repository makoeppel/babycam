# quickstart
python -m venv venv
source venv/bin/activate
sudo SITE=babycam.example.com ./install.sh

# battery (http://<your raspberry ip>:8421)
wget https://cdn.pisugar.com/release/pisugar-power-manager.sh
bash pisugar-power-manager.sh -c release

# install
sudo apt-get install -y ffmpeg
sudo apt-get install -y python3-flask alsa-utils

# caddy
sudo apt-get install caddy
cp Caddyfile /etc/caddy/Caddyfile
caddy hash-password --plaintext 'YOUR_PASSWORD'
sudo systemctl reload caddy.service

# start server
sudo cp babycam.service /lib/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable babycam.service
sudo systemctl start babycam.service
