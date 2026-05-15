import spotipy
from spotipy.oauth2 import SpotifyClientCredentials
import sys

CLIENT_ID = 'aa117582683449f9846a783d421ffc35'
CLIENT_SECRET = 'a3e07f553342408c85b5ca62ea14696a'

auth_manager = SpotifyClientCredentials(client_id=CLIENT_ID, client_secret=CLIENT_SECRET)
sp = spotipy.Spotify(auth_manager=auth_manager)

try:
    # Without quotes
    res1 = sp.search(q='artist:Martin Garrix track:Empty', type='track', limit=1)
    isrc1 = res1['tracks']['items'][0].get('external_ids', {}).get('isrc') if res1['tracks']['items'] else "NOT FOUND"
    print("Without quotes:", isrc1)
    
    # With quotes
    res2 = sp.search(q='artist:"Martin Garrix" track:"Empty"', type='track', limit=1)
    isrc2 = res2['tracks']['items'][0].get('external_ids', {}).get('isrc') if res2['tracks']['items'] else "NOT FOUND"
    print("With quotes:", isrc2)
    
except Exception as e:
    print("Error:", e)
