import spotipy
from spotipy.oauth2 import SpotifyClientCredentials
import sys

CLIENT_ID = 'aa117582683449f9846a783d421ffc35'
CLIENT_SECRET = 'a3e07f553342408c85b5ca62ea14696a'

sp = spotipy.Spotify(auth_manager=SpotifyClientCredentials(
    client_id=CLIENT_ID,
    client_secret=CLIENT_SECRET
))

try:
    track = sp.track('575ViHchpSUjfTLCQPdE49')
    print("Track ISRC:", track.get('external_ids', {}).get('isrc'))
except Exception as e:
    print("Track failed:", e)
