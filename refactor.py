import os

filepath = 'new_app.py'

with open(filepath, 'r', encoding='utf-8') as f:
    content = f.read()

# 1. Imports
if 'import spotipy' not in content:
    content = content.replace('import streamlit as st', 'import streamlit as st\nimport time\nimport spotipy\nfrom spotipy.oauth2 import SpotifyClientCredentials')

# 2. UI for credentials
ui_block = """st.info("🔒 Your data is processed in real-time in the server's memory and is not saved to any database.")

with st.expander("🔑 HOW TO GET MY CLIENT ID AND CLIENT SECRET (Required for accurate Track Matching)"):
    st.markdown('''
    To accurately count your songs, this app uses the **Spotify Developer API** to fetch the ISRC (a unique ID) for each track. 
    **Why?** Because Spotify often changes a song\\'s internal ID depending on whether it\\'s a single, album, or compilation.
    
    **Is it secure?** YES! 🔒
    - We do NOT ask for your Spotify password.
    - We do NOT access your personal account data, playlists, or private history.
    - We ONLY use these keys to search Spotify\\'s *public* database for song information.
    - Your keys are used locally and are never saved to our servers.

    **How to get them (Takes 1 minute):**
    1. Go to [Spotify Developer Dashboard](https://developer.spotify.com/dashboard) and log in.
    2. Click on **Create app**.
    3. App name: `Spotify Stats Analyzer` (or anything). App description: `Data analysis`.
    4. Redirect URI: `http://localhost:8501`
    5. Check the Developer Terms of Service and click **Save**.
    6. Click on your new app, then go to **Settings**.
    7. You will see your **Client ID** and an option to view your **Client Secret**. Copy them and paste them below!
    ''')
    
col_keys1, col_keys2 = st.columns(2)
with col_keys1:
    client_id = st.text_input("🔑 Spotify Client ID:", type="password")
with col_keys2:
    client_secret = st.text_input("🔑 Spotify Client Secret:", type="password")

uploaded_files = st.file_uploader("📂 Upload your Spotify Extended Streaming History JSON files:", type="json", accept_multiple_files=True)"""

content = content.replace('st.info("🔒 Your data is processed in real-time in the server\'s memory and is not saved to any database.")\n\nuploaded_files = st.file_uploader("📂 Upload your Spotify Extended Streaming History JSON files:", type="json", accept_multiple_files=True)', ui_block)

# 3. Modify load_data definition
content = content.replace('def load_data(files):', 'def load_data(files, cid, csecret):')
content = content.replace('raw_df = load_data(uploaded_files)', 'raw_df = load_data(uploaded_files, client_id, client_secret)')

# 4. Inject ISRC logic inside load_data
old_grouping = """    # 💡 גישה א': שימוש בתעודת הזהות (URI) - Grouping tracks strictly by their spotify_track_uri
    if 'spotify_track_uri' not in df.columns:
        df['spotify_track_uri'] = 'local:' + df['clean_track_name'] + '-' + df['canonical_artist']
    else:
        df['spotify_track_uri'] = df['spotify_track_uri'].fillna('local:' + df['clean_track_name'] + '-' + df['canonical_artist'])

    # Map each URI to a definitive track name and artist name for clean displays
    uri_meta = df.groupby('spotify_track_uri').agg({
        'clean_track_name': 'first',
        'canonical_artist': 'first'
    }).to_dict()
    df['clean_track_name'] = df['spotify_track_uri'].map(uri_meta['clean_track_name'])
    df['canonical_artist'] = df['spotify_track_uri'].map(uri_meta['canonical_artist'])"""

new_grouping = """    # 💡 גישה א': שימוש בתעודת הזהות (URI) - Grouping tracks strictly by their spotify_track_uri
    if 'spotify_track_uri' not in df.columns:
        df['spotify_track_uri'] = 'local:' + df['clean_track_name'] + '-' + df['canonical_artist']
    else:
        df['spotify_track_uri'] = df['spotify_track_uri'].fillna('local:' + df['clean_track_name'] + '-' + df['canonical_artist'])

    unique_uris = df['spotify_track_uri'].dropna().unique().tolist()
    
    if cid and csecret:
        try:
            auth_manager = SpotifyClientCredentials(client_id=cid, client_secret=csecret)
            sp = spotipy.Spotify(auth_manager=auth_manager)
            
            uri_to_isrc = {}
            valid_uris = [uri for uri in unique_uris if str(uri).startswith('spotify:track:')]
            
            progress_text = "Fetching unique track codes (ISRC) from Spotify... Please wait."
            my_bar = st.progress(0, text=progress_text)
            
            total = len(valid_uris)
            chunk_size = 50
            for i in range(0, total, chunk_size):
                chunk = valid_uris[i:i+chunk_size]
                try:
                    results = sp.tracks(chunk)
                    for track in results['tracks']:
                        if track is not None:
                            uri = track.get('uri')
                            isrc = track.get('external_ids', {}).get('isrc')
                            if uri and isrc:
                                uri_to_isrc[uri] = isrc
                except Exception as e:
                    time.sleep(1)
                
                progress = min(1.0, (i + chunk_size) / total)
                my_bar.progress(progress, text=f"Fetching ISRCs... {min(i+chunk_size, total)} / {total}")
                time.sleep(0.1)
                
            my_bar.empty()
            df['isrc'] = df['spotify_track_uri'].map(uri_to_isrc).fillna(df['spotify_track_uri'])
        except Exception as e:
            st.error(f"Failed to authenticate with Spotify: {e}")
            df['isrc'] = df['spotify_track_uri']
    else:
        df['isrc'] = df['spotify_track_uri']

    # Map each ISRC to a definitive track name and artist name for clean displays
    uri_meta = df.groupby('isrc').agg({
        'clean_track_name': 'first',
        'canonical_artist': 'first'
    }).to_dict()
    df['clean_track_name'] = df['isrc'].map(uri_meta['clean_track_name'])
    df['canonical_artist'] = df['isrc'].map(uri_meta['canonical_artist'])"""

content = content.replace(old_grouping, new_grouping)

# 5. Global replacement of 'spotify_track_uri' to 'isrc' AFTER load_data
# We'll split the content into two parts: before the end of load_data, and after.
parts = content.split('return df')
if len(parts) == 2:
    part1, part2 = parts
    part2 = part2.replace("'spotify_track_uri'", "'isrc'")
    content = part1 + 'return df' + part2

with open(filepath, 'w', encoding='utf-8') as f:
    f.write(content)

print("Refactor complete.")
