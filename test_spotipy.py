import spotipy
from spotipy.oauth2 import SpotifyClientCredentials
import sys

cid = 'YOUR_CID_HERE'
csecret = 'YOUR_SECRET_HERE'

if cid == 'YOUR_CID_HERE':
    print("No valid credentials to test, but script syntax is fine.")
    sys.exit(0)

auth_manager = SpotifyClientCredentials(client_id=cid, client_secret=csecret)
sp = spotipy.Spotify(auth_manager=auth_manager)
uris = ['spotify:track:0LV5p1qV4aO4Q6m92bH7aC'] # Just a guess URI
try:
    results = sp.tracks(uris)
    print(results)
except Exception as e:
    print("Error:", e)
