import spotipy
from spotipy.oauth2 import SpotifyClientCredentials

CLIENT_ID = 'aa117582683449f9846a783d421ffc35'
CLIENT_SECRET = 'a3e07f553342408c85b5ca62ea14696a'

sp = spotipy.Spotify(auth_manager=SpotifyClientCredentials(
    client_id=CLIENT_ID,
    client_secret=CLIENT_SECRET
))

try:
    res1 = sp.search(q='artist:"Martin Garrix" track:"Empty"', type='track', limit=1)
    isrc1 = res1['tracks']['items'][0].get('external_ids', {}).get('isrc') if res1['tracks']['items'] else "NOT FOUND"
    print("Martin Garrix Empty ISRC:", isrc1)
    
    res2 = sp.search(q='artist:"DubVision" track:"Empty"', type='track', limit=1)
    isrc2 = res2['tracks']['items'][0].get('external_ids', {}).get('isrc') if res2['tracks']['items'] else "NOT FOUND"
    print("DubVision Empty ISRC:", isrc2)
    
except Exception as e:
    print("Error:", e)
