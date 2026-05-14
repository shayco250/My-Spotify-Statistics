import spotipy
from spotipy.oauth2 import SpotifyClientCredentials
import sys
import time
from concurrent.futures import ThreadPoolExecutor

CLIENT_ID = 'aa117582683449f9846a783d421ffc35'
CLIENT_SECRET = 'a3e07f553342408c85b5ca62ea14696a'

sp = spotipy.Spotify(auth_manager=SpotifyClientCredentials(
    client_id=CLIENT_ID,
    client_secret=CLIENT_SECRET
))

def fetch_isrc(track_id):
    try:
        track = sp.track(track_id)
        return track.get('external_ids', {}).get('isrc')
    except Exception as e:
        return None

# Generate 50 identical requests just to test rate limiting
ids = ['575ViHchpSUjfTLCQPdE49'] * 50

start = time.time()
with ThreadPoolExecutor(max_workers=10) as executor:
    results = list(executor.map(fetch_isrc, ids))
end = time.time()

print(f"Fetched {len(results)} tracks in {end - start:.2f} seconds.")
print(f"Successes: {len([r for r in results if r])}")
