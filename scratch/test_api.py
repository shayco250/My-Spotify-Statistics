import spotipy
from spotipy.oauth2 import SpotifyClientCredentials
import sys

CLIENT_ID = 'aa117582683449f9846a783d421ffc35'
CLIENT_SECRET = 'a3e07f553342408c85b5ca62ea14696a'

sp = spotipy.Spotify(auth_manager=SpotifyClientCredentials(
    client_id=CLIENT_ID,
    client_secret=CLIENT_SECRET
))

print("Testing sp.search()...")
try:
    results = sp.search(q='artist:"Martin Garrix" track:"Empty"', type='track', limit=1)
    if results['tracks']['items']:
        print("Search SUCCESS. ISRC:", results['tracks']['items'][0].get('external_ids', {}).get('isrc'))
        track_id = results['tracks']['items'][0]['id']
    else:
        print("Search returned no items.")
        sys.exit(1)
except Exception as e:
    print("Search failed:", e)

print("\nTesting sp.tracks()...")
try:
    tracks_result = sp.tracks([track_id])
    print("Tracks SUCCESS. ISRC:", tracks_result['tracks'][0].get('external_ids', {}).get('isrc'))
except Exception as e:
    print("Tracks failed:", e)
