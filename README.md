https://github.com/nksan/Rpi-SetWiFi-viaBluetooth

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
cp babycam.service /lib/systemd/system/
python stream.py
