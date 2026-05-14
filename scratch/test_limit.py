import spotipy
from spotipy.oauth2 import SpotifyClientCredentials
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed

CLIENT_ID = 'aa117582683449f9846a783d421ffc35'
CLIENT_SECRET = 'a3e07f553342408c85b5ca62ea14696a'

sp = spotipy.Spotify(auth_manager=SpotifyClientCredentials(
    client_id=CLIENT_ID,
    client_secret=CLIENT_SECRET
))

def fetch_single_isrc(tid):
    try:
        track = sp.track(tid)
        return track.get('external_ids', {}).get('isrc')
    except Exception as e:
        return None

# Generate 500 identical requests
ids = ['575ViHchpSUjfTLCQPdE49'] * 500

start = time.time()
processed = 0
with ThreadPoolExecutor(max_workers=15) as executor:
    futures = {executor.submit(fetch_single_isrc, tid): tid for tid in ids}
    for future in as_completed(futures):
        res = future.result()
        processed += 1
        if processed % 10 == 0:
            print(f"Processed {processed}/500")

end = time.time()
print(f"Finished in {end - start:.2f} seconds.")
