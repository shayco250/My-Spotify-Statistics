import spotipy
from spotipy.oauth2 import SpotifyClientCredentials
import requests
import sys

CLIENT_ID = 'aa117582683449f9846a783d421ffc35'
CLIENT_SECRET = 'a3e07f553342408c85b5ca62ea14696a'

auth_manager = SpotifyClientCredentials(client_id=CLIENT_ID, client_secret=CLIENT_SECRET)
token = auth_manager.get_access_token(as_dict=False)

headers = {'Authorization': f'Bearer {token}'}
response = requests.get('https://api.spotify.com/v1/tracks?ids=575ViHchpSUjfTLCQPdE49,0LV5p1qV4aO4Q6m92bH7aC&market=US', headers=headers)

print("Status:", response.status_code)
if response.status_code == 200:
    data = response.json()
    print("Success. Tracks returned:", len(data['tracks']))
else:
    print("Error:", response.text)
