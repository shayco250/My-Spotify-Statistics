import streamlit as st
import time
import spotipy
from spotipy.oauth2 import SpotifyClientCredentials
import pandas as pd
import numpy as np
import plotly.express as px
import plotly.graph_objects as go
import re

# להרצת האתר:
# cd "C:\Users\shayc\Desktop\Spotify Project"
# py -m streamlit run new_app.py

# ==========================================
# Page Config & Minimal Styling
# ==========================================
st.set_page_config(layout="wide", page_title="Spotify Analytics (Raw Data)", page_icon="🎧")

st.markdown("""
    <style>
        h1, h2, h3 {
            color: #1DB954 !important;
        }
    </style>
""", unsafe_allow_html=True)

st.title("Spotify Analytics 🎧")

st.info("🔒 Your data is processed in real-time in the server's memory and is not saved to any database.")

with st.expander("🔑 HOW TO GET MY CLIENT ID AND CLIENT SECRET (Required for accurate Track Matching)"):
    st.markdown('''
    To accurately count your songs, this app uses the **Spotify Developer API** to fetch the ISRC (a unique ID) for each track. 
    **Why?** Because Spotify often changes a song\'s internal ID depending on whether it\'s a single, album, or compilation.
    
    **Is it secure?** YES! 🔒
    - We do NOT ask for your Spotify password.
    - We do NOT access your personal account data, playlists, or private history.
    - We ONLY use these keys to search Spotify\'s *public* database for song information.
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

uploaded_files = st.file_uploader("📂 Upload your Spotify Extended Streaming History JSON files:", type="json", accept_multiple_files=True)

user_profile_link = st.text_input("🔗 Enter your Spotify Profile Link (Optional):", "")
if user_profile_link:
    st.markdown(f"[My Profile]({user_profile_link})")

st.markdown("---")

# ==========================================
# Data Loading (Adapted for Raw Spotify History)
# ==========================================
@st.cache_data
def load_data(files, cid, csecret):
    if not files:
        return pd.DataFrame()

    dfs = []
    for f in files:
        try:
            df_temp = pd.read_json(f)
            dfs.append(df_temp)
        except Exception as e:
            st.error(f"Error loading file {f.name}: {e}")
            
    if not dfs:
        return pd.DataFrame()
        
    df = pd.concat(dfs, ignore_index=True)

    if 'master_metadata_track_name' not in df.columns:
        st.error("הקובץ לא נראה כמו היסטוריית אודיו גולמית של ספוטיפיי.")
        return pd.DataFrame()

    df = df.dropna(subset=['master_metadata_track_name', 'master_metadata_album_artist_name'])

    df['ts'] = pd.to_datetime(df['ts'], errors='coerce', utc=True)
    try:
        df['ts'] = df['ts'].dt.tz_convert('Asia/Jerusalem').dt.tz_localize(None)
    except:
        df['ts'] = df['ts'].dt.tz_localize(None)

    df['DateOnly'] = df['ts'].dt.date

    if 'ms_played' in df.columns:
        df['length_seconds'] = df['ms_played'] / 1000
    else:
        df['length_seconds'] = 0

    df['length_hours'] = df['length_seconds'] / 3600

    def clean_song_name(name):
        name = str(name)
        if ' - ' in name:
            parts = name.split(' - ')
            if any(word in parts[-1].lower() for word in ['mix', 'edit', 'version', 'remaster', 'live', 'instrumental']):
                name = ' - '.join(parts[:-1])
        name = re.sub(r'\s*[\(\[].*?(edit|mix|version|remaster|live|instrumental).*?[\)\]]', '', name, flags=re.IGNORECASE)
        return name.strip()

    df['clean_track_name'] = df['master_metadata_track_name'].apply(clean_song_name)
    df['canonical_artist'] = df['master_metadata_album_artist_name'].astype(str).str.strip()
    
    # 💡 גישה א': שימוש בתעודת הזהות (URI) - Grouping tracks strictly by their spotify_track_uri
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
            # --- SMART FILTERING VIA SEARCH ---
            # To resolve completely different URIs/Artists for the same track, we use Spotify Search.
            name_uri_counts = df.groupby('clean_track_name')['spotify_track_uri'].nunique()
            duplicate_names = name_uri_counts[name_uri_counts > 1].index
            
            suspected_duplicates_df = df[df['clean_track_name'].isin(duplicate_names)]
            unique_pairs = suspected_duplicates_df[['clean_track_name', 'canonical_artist']].drop_duplicates().values.tolist()
            
            total = len(unique_pairs)
            pair_to_isrc = {}
            
            if total > 0:
                progress_text = f"Smart Scanning: Resolving {total} combinations via Spotify Search..."
                my_bar = st.progress(0, text=progress_text)
                
                sp = spotipy.Spotify(auth_manager=auth_manager, retries=0, requests_timeout=5)
                start_time = time.time()
                
                for i, (t_name, a_name) in enumerate(unique_pairs):
                    try:
                        # Searching exactly like the user's python script
                        # Taking the very first search result to extract the master ISRC
                        q_str = f"artist:{a_name} track:{t_name}"
                        results = sp.search(q=q_str, type='track', limit=1)
                        tracks = results.get('tracks', {}).get('items', [])
                        if tracks:
                            isrc_val = tracks[0].get('external_ids', {}).get('isrc')
                            if isrc_val:
                                pair_to_isrc[(t_name, a_name)] = isrc_val
                    except Exception as e:
                        pass
                        
                    # Safe sleep
                    time.sleep(0.3)
                    
                    processed = i + 1
                    if processed % 3 == 0 or processed == total:
                        progress = processed / total
                        elapsed = time.time() - start_time
                        est_total_time = (elapsed / processed) * total
                        time_left = max(0, est_total_time - elapsed)
                        
                        if time_left > 60:
                            time_str = f"{int(time_left // 60)}m {int(time_left % 60)}s"
                        else:
                            time_str = f"{int(time_left)}s"
                            
                        percent = int(progress * 100)
                        my_bar.progress(progress, text=f"Resolving Duplicates... {percent}% ({processed}/{total}) | ETA: {time_str}")
                
                my_bar.empty()
            
            # Map the results to the dataframe efficiently
            # We create a tuple column just for mapping
            pair_series = pd.Series(list(zip(df['clean_track_name'], df['canonical_artist'])))
            df['isrc'] = pair_series.map(pair_to_isrc).fillna(df['spotify_track_uri'])
            
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
    df['canonical_artist'] = df['isrc'].map(uri_meta['canonical_artist'])

    df = df.sort_values('ts').reset_index(drop=True)
    df['time_diff'] = df['ts'].diff()
    df['is_new_session'] = (df['time_diff'] >= pd.Timedelta(minutes=180)) | (df['time_diff'].isnull())
    df['session_id'] = df['is_new_session'].cumsum()

    return df


def calculate_obsession(history_df, ref_date):
    if history_df.empty: return pd.DataFrame()
    ref_date = pd.to_datetime(ref_date)

    stats = history_df.groupby('isrc').agg(
        clean_track_name=('clean_track_name', 'first'),
        canonical_artist=('canonical_artist', 'first'),
        first_play=('ts', 'min'),
        last_play=('ts', 'max'),
        unique_days=('DateOnly', 'nunique'),
        total_plays=('ts', 'count')
    ).reset_index()

    stats['days_since_first'] = (ref_date - stats['first_play']).dt.days.clip(lower=0)
    stats['days_since_last'] = (ref_date - stats['last_play']).dt.days.clip(lower=0)

    stats['density'] = stats['unique_days'] / (stats['days_since_first'] + 5)
    stats['volume'] = np.log10(stats['total_plays'] + 1)
    stats['recency'] = np.exp(-0.015 * stats['days_since_last'])

    stats['raw_score'] = (0.4 * stats['density']) + (0.35 * stats['volume']) + (0.25 * stats['recency'])

    min_score = stats['raw_score'].min()
    max_score = stats['raw_score'].max()
    if max_score > min_score:
        stats['Obsession Score'] = 1 + 99 * (stats['raw_score'] - min_score) / (max_score - min_score)
    else:
        stats['Obsession Score'] = 50.0

    stats['Obsession Score'] = stats['Obsession Score'].round(2)
    return stats.sort_values('Obsession Score', ascending=False)

if uploaded_files:
    if st.button("🚀 Show My Spotify Statistics"):
        with st.spinner("Analyzing your Spotify History..."):
            st.session_state['raw_df'] = load_data(uploaded_files, client_id, client_secret)
        st.session_state['data_loaded'] = True

raw_df = None
if st.session_state.get('data_loaded', False) and 'raw_df' in st.session_state:
    raw_df = st.session_state['raw_df']


# ==========================================
# GLOBAL DATE FILTER WITH RESET BUTTON
# ==========================================
if raw_df is not None and not raw_df.empty:
    st.header("📅 Select Date Range")

    min_date = raw_df['ts'].min().date()
    max_date = raw_df['ts'].max().date()

    if 'start_date' not in st.session_state:
        st.session_state['start_date'] = min_date
    if 'end_date' not in st.session_state:
        st.session_state['end_date'] = max_date

    all_years = sorted(raw_df['ts'].dt.year.dropna().unique())
    year_options = ["Custom"] + [str(y) for y in all_years]
    
    def change_year():
        selected_year_val = st.session_state['selected_year']
        if selected_year_val != "Custom":
            y = int(selected_year_val)
            y_df = raw_df[raw_df['ts'].dt.year == y]
            if not y_df.empty:
                proposed_start = pd.Timestamp(year=y, month=1, day=1).date()
                proposed_end = pd.Timestamp(year=y, month=12, day=31).date()
                
                st.session_state['start_date'] = max(proposed_start, min_date)
                st.session_state['end_date'] = min(proposed_end, max_date)
    
    col_str, col_d1, col_d2, col_d3 = st.columns([1.5, 2, 2, 1])
    with col_str:
        st.selectbox("Shortcut (Full Year)", year_options, key='selected_year', on_change=change_year)
    with col_d1:
        start_date = st.date_input("Start Date", key='start_date', min_value=min_date, max_value=max_date)
    with col_d2:
        end_date = st.date_input("End Date", key='end_date', min_value=min_date, max_value=max_date)
        
    def reset_dates():
        st.session_state['start_date'] = min_date
        st.session_state['end_date'] = max_date
        st.session_state['selected_year'] = "Custom"
        
    with col_d3:
        st.write("")
        st.write("")
        st.button("🔄 Reset Dates", on_click=reset_dates, use_container_width=True)

    mask = (raw_df['ts'].dt.date >= start_date) & (raw_df['ts'].dt.date <= end_date)
    df_all = raw_df.loc[mask].copy()
    df = df_all[df_all['length_seconds'] >= 30].copy()

    st.markdown("---")

    if df.empty:
        st.warning("No data found for the selected date range.")
    else:
        df['month_year'] = df['ts'].dt.to_period('M')
        df_all['month_year'] = df_all['ts'].dt.to_period('M')

        # Since raw data mostly has 1 canonical artist per row, we mimic df_artists for consistency:
        df_artists = df.copy()
        df_artists['all artists'] = df_artists['canonical_artist']
        df_artists_all = df_all.copy()
        df_artists_all['all artists'] = df_artists_all['canonical_artist']

        # ==========================================
        # Section 1: Overview Metrics
        # ==========================================
        st.header("📊 At a Glance")

        c1, c2, c3, c4, c5 = st.columns(5)

        total_hours = df_all['length_hours'].sum()
        c1.metric("Total Hours", f"{total_hours:,.0f} hrs")

        total_streams = len(df)
        c2.metric("Total Streams", f"{total_streams:,}")

        unique_songs = df['isrc'].nunique()
        c3.metric("Unique Songs", f"{unique_songs:,}")

        unique_artists_count = df_artists['all artists'].nunique()
        c4.metric("Unique Artists", f"{unique_artists_count:,}")

        top_song_grouped = df.groupby('isrc').size().sort_values(ascending=False)
        if not top_song_grouped.empty:
            top_song_uri = top_song_grouped.index[0]
            top_song_plays = top_song_grouped.iloc[0]
            top_song_name = df[df['isrc'] == top_song_uri]['clean_track_name'].iloc[0]
            c5.metric("Top Song", f"{top_song_name}", f"{top_song_plays} plays")

        st.markdown("---")

        # ==========================================
        # Section 2 & 3: Top Tracks & Top Artists
        # ==========================================
        st.header("🏆 Top Items")
        st.write("#### How many to display?")
        
        col_t, col_a = st.columns(2)
        
        with col_t:
            top_n_songs = st.slider("Tracks to Display", min_value=5, max_value=100, value=10, step=5, key='slider_tracks')
            st.subheader("🎵 Top Tracks")
            
            top_songs_df = df.groupby('isrc').agg(
                plays=('ts', 'count'),
                Track_Name=('clean_track_name', 'first'),
                Lead_Artist=('canonical_artist', 'first')
            ).reset_index()

            track_hours_all = df_all.groupby('isrc')['length_hours'].sum()
            top_songs_df['total_hours'] = top_songs_df['isrc'].map(track_hours_all).fillna(0)

            top_songs_df = top_songs_df.sort_values(by='plays', ascending=False).head(top_n_songs)
            top_songs_df.insert(0, '#', range(1, len(top_songs_df) + 1))
            
            display_songs_df = top_songs_df.rename(columns={
                'Track_Name': 'Track Name',
                'Lead_Artist': 'Lead Artist',
                'plays': 'Streams',
                'total_hours': 'Total Hours'
            })[['#', 'Track Name', 'Lead Artist', 'Streams', 'Total Hours']]
            
            display_songs_df['Total Hours'] = display_songs_df['Total Hours'].round(1)
            st.dataframe(display_songs_df.style.format({"Total Hours": "{:.1f}"}).set_properties(**{'text-align': 'center'}), hide_index=True, use_container_width=True)

        with col_a:
            top_n_artists = st.slider("Artists to Display", min_value=5, max_value=100, value=10, step=5, key='slider_artists')
            st.subheader("🎤 Top Artists")
            
            top_artists_df = df_artists.groupby('all artists').agg(
                plays=('ts', 'count'),
                unique_songs=('isrc', 'nunique')
            ).reset_index()

            artist_hours_all = df_artists_all.groupby('all artists')['length_hours'].sum()
            top_artists_df['total_hours'] = top_artists_df['all artists'].map(artist_hours_all).fillna(0)

            top_artists_df = top_artists_df.sort_values(by='plays', ascending=False).head(top_n_artists)
            top_artists_df.insert(0, '#', range(1, len(top_artists_df) + 1))

            display_artists_df = top_artists_df.rename(columns={
                'all artists': 'Artist Name',
                'plays': 'Streams',
                'unique_songs': 'Unique Tracks',
                'total_hours': 'Total Hours'
            })[['#', 'Artist Name', 'Streams', 'Unique Tracks', 'Total Hours']]
            
            display_artists_df['Total Hours'] = display_artists_df['Total Hours'].round(1)
            st.dataframe(display_artists_df.style.format({"Total Hours": "{:.1f}"}).set_properties(**{'text-align': 'center'}), hide_index=True, use_container_width=True)

        st.markdown("---")

        # ==========================================
        # Global Heatmap
        # ==========================================
        st.header("🔥 Global Listening Heatmap")
        
        available_global_years = sorted(df['ts'].dt.year.unique(), reverse=True)
        if available_global_years:
            selected_global_year = st.selectbox("Select Year for Heatmap", available_global_years, key='global_heatmap_year')
            
            g_daily_plays = df[df['ts'].dt.year == selected_global_year].groupby('DateOnly').size()

            g_heatmap_z = np.zeros((12, 31))
            g_heatmap_text = np.full((12, 31), "", dtype=object)
            g_hover_text = np.full((12, 31), "", dtype=object)

            for m in range(1, 13):
                for d in range(1, 32):
                    try:
                        dt_obj = pd.Timestamp(year=selected_global_year, month=m, day=d).date()
                        plays = g_daily_plays.get(dt_obj, 0)
                        
                        g_hover_text[m - 1, d - 1] = f"{dt_obj}<br>{plays} plays"
                        
                        if plays == 0:
                            g_heatmap_z[m - 1, d - 1] = 0
                            g_heatmap_text[m - 1, d - 1] = f"<span style='color:white'>{d}</span>"
                        else:
                            g_heatmap_text[m - 1, d - 1] = f"<span style='color:black'>{d}</span>"
                            if plays <= 19:
                                g_heatmap_z[m - 1, d - 1] = 1
                            elif plays <= 29:
                                g_heatmap_z[m - 1, d - 1] = 2
                            elif plays <= 49:
                                g_heatmap_z[m - 1, d - 1] = 3
                            elif plays <= 69:
                                g_heatmap_z[m - 1, d - 1] = 4
                            elif plays <= 89:
                                g_heatmap_z[m - 1, d - 1] = 5
                            elif plays <= 99:
                                g_heatmap_z[m - 1, d - 1] = 6
                            else:  # 100+
                                g_heatmap_z[m - 1, d - 1] = 7
                            
                    except ValueError:
                        g_heatmap_z[m - 1, d - 1] = None
                        g_heatmap_text[m - 1, d - 1] = ""
                        g_hover_text[m - 1, d - 1] = "Invalid Date"

            custom_colorscale_global = [
                [0.0, '#222222'], [1/8, '#222222'],
                [1/8, '#ffffcc'], [2/8, '#ffffcc'],
                [2/8, '#ffeb66'], [3/8, '#ffeb66'],
                [3/8, '#ffcc00'], [4/8, '#ffcc00'],
                [4/8, '#ffa600'], [5/8, '#ffa600'],
                [5/8, '#ff7a00'], [6/8, '#ff7a00'],
                [6/8, '#e63e00'], [7/8, '#e63e00'],
                [7/8, '#cc0000'], [1.0, '#cc0000']
            ]

            fig_global_heat = go.Figure(data=go.Heatmap(
                z=g_heatmap_z,
                x=list(range(1, 32)),
                y=['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
                text=g_heatmap_text,
                texttemplate="<b>%{text}</b>",
                textfont=dict(size=9),
                customdata=g_hover_text,
                hovertemplate="%{customdata}<extra></extra>",
                colorscale=custom_colorscale_global,
                zmin=0, zmax=7,
                showscale=False,
                xgap=3, ygap=3
            ))

            fig_global_heat.update_layout(
                plot_bgcolor='rgba(0,0,0,0)', paper_bgcolor='rgba(0,0,0,0)', font_color='white',
                yaxis_autorange="reversed",
                xaxis=dict(tickmode='linear', dtick=1, showgrid=False, zeroline=False),
                yaxis=dict(showgrid=False, zeroline=False),
                height=450
            )
            st.plotly_chart(fig_global_heat, use_container_width=True)

            # ---- Heatmap Legend ----
            st.markdown("""
            <div style="display:flex; flex-wrap:wrap; align-items:center; gap:10px 18px; margin-top:4px; margin-bottom:8px; justify-content:center;">
                <span style="font-size:13px; color:#aaa; margin-right:4px; font-weight:600;">🗺️ Legend:</span>
                <span style="display:inline-flex;align-items:center;gap:6px;">
                    <span style="width:22px;height:22px;border-radius:4px;background:#222222;display:inline-block;border:1px solid #444;"></span>
                    <span style="font-size:13px;color:#ddd;">0 plays</span>
                </span>
                <span style="display:inline-flex;align-items:center;gap:6px;">
                    <span style="width:22px;height:22px;border-radius:4px;background:#ffffcc;display:inline-block;border:1px solid #555;"></span>
                    <span style="font-size:13px;color:#ddd;">1–19</span>
                </span>
                <span style="display:inline-flex;align-items:center;gap:6px;">
                    <span style="width:22px;height:22px;border-radius:4px;background:#ffeb66;display:inline-block;border:1px solid #555;"></span>
                    <span style="font-size:13px;color:#ddd;">20–29</span>
                </span>
                <span style="display:inline-flex;align-items:center;gap:6px;">
                    <span style="width:22px;height:22px;border-radius:4px;background:#ffcc00;display:inline-block;border:1px solid #555;"></span>
                    <span style="font-size:13px;color:#ddd;">30–49</span>
                </span>
                <span style="display:inline-flex;align-items:center;gap:6px;">
                    <span style="width:22px;height:22px;border-radius:4px;background:#ffa600;display:inline-block;border:1px solid #555;"></span>
                    <span style="font-size:13px;color:#ddd;">50–69</span>
                </span>
                <span style="display:inline-flex;align-items:center;gap:6px;">
                    <span style="width:22px;height:22px;border-radius:4px;background:#ff7a00;display:inline-block;border:1px solid #555;"></span>
                    <span style="font-size:13px;color:#ddd;">70–89</span>
                </span>
                <span style="display:inline-flex;align-items:center;gap:6px;">
                    <span style="width:22px;height:22px;border-radius:4px;background:#e63e00;display:inline-block;border:1px solid #555;"></span>
                    <span style="font-size:13px;color:#ddd;">90–99</span>
                </span>
                <span style="display:inline-flex;align-items:center;gap:6px;">
                    <span style="width:22px;height:22px;border-radius:4px;background:#cc0000;display:inline-block;border:1px solid #555;"></span>
                    <span style="font-size:13px;color:#ddd;">100+</span>
                </span>
            </div>
            """, unsafe_allow_html=True)

        st.markdown("---")

        # ==========================================
        # Section 4: Listening Over Time
        # ==========================================
        st.header("📈 Listening Over Time")

        monthly_stats = df_all.groupby('month_year')['length_hours'].sum().reset_index()
        monthly_stats['month_year_str'] = monthly_stats['month_year'].astype(str)

        available_chart_years = sorted(df_all['ts'].dt.year.dropna().unique(), reverse=True)
        chart_year_options = ["All Time"] + [int(y) for y in available_chart_years]
        selected_chart_year = st.selectbox("Select Year for Chart:", chart_year_options, key='listening_over_time_year')

        if selected_chart_year == "All Time":
            lot_df = df_all.copy()
        else:
            lot_df = df_all[df_all['ts'].dt.year == selected_chart_year].copy()

        monthly_stats = lot_df.groupby('month_year')['length_hours'].sum().reset_index()
        monthly_stats['month_year_str'] = monthly_stats['month_year'].astype(str)

        if not monthly_stats.empty:
            max_month = monthly_stats.loc[monthly_stats['length_hours'].idxmax(), 'month_year_str']
            colors_monthly = ['#8A2BE2' if m == max_month else '#1DB954' for m in monthly_stats['month_year_str']]

            fig_months = px.bar(
                monthly_stats,
                x='month_year_str',
                y='length_hours',
                title=f"Listening Hours by Month ({selected_chart_year})",
                labels={'month_year_str': 'Month', 'length_hours': 'Hours'}
            )
            fig_months.update_traces(marker_color=colors_monthly, textposition='outside', texttemplate='<b>%{y:.1f}</b>')
            fig_months.update_layout(plot_bgcolor='rgba(0,0,0,0)', paper_bgcolor='rgba(0,0,0,0)', font_color='white')
            st.plotly_chart(fig_months, use_container_width=True)

        st.markdown("---")

        # ==========================================
        # Section 5: When do I listen?
        # ==========================================
        st.header("⏰ When Do I Listen?")

        df['Hour'] = df['ts'].dt.hour
        df['DayOfWeek'] = df['ts'].dt.dayofweek

        day_map = {0: 'Monday', 1: 'Tuesday', 2: 'Wednesday', 3: 'Thursday', 4: 'Friday', 5: 'Saturday', 6: 'Sunday'}
        df['DayName'] = df['DayOfWeek'].map(day_map)

        col_time1, col_time2 = st.columns(2)

        with col_time1:
            hourly_counts = df['Hour'].value_counts().sort_index().reset_index()
            hourly_counts.columns = ['Hour', 'Plays']

            if not hourly_counts.empty:
                max_hour = hourly_counts.loc[hourly_counts['Plays'].idxmax(), 'Hour']
                colors = ['#1ED760' if h == max_hour else '#535353' for h in hourly_counts['Hour']]

                fig_hour = px.bar(
                    hourly_counts, x='Hour', y='Plays',
                    title=f"Streams by Hour (Peak: {max_hour}:00)",
                    labels={'Hour': 'Hour of Day', 'Plays': 'Streams'},
                    text_auto=True
                )
                fig_hour.update_traces(marker_color=colors, textposition='outside')
                fig_hour.update_layout(plot_bgcolor='rgba(0,0,0,0)', paper_bgcolor='rgba(0,0,0,0)', font_color='white',
                                       xaxis=dict(tickmode='linear', tick0=0, dtick=1))
                st.plotly_chart(fig_hour, use_container_width=True)

        with col_time2:
            days_order = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
            daily_counts = df['DayName'].value_counts().reindex(days_order).reset_index()
            daily_counts.columns = ['Day', 'Plays']

            if not daily_counts.empty:
                max_day_stat = daily_counts.loc[daily_counts['Plays'].idxmax(), 'Day']
                colors_day = ['#8A2BE2' if d == max_day_stat else '#1DB954' for d in daily_counts['Day']]

                fig_day = px.bar(
                    daily_counts, x='Day', y='Plays',
                    title="Streams by Day of Week",
                    labels={'Day': 'Day', 'Plays': 'Streams'}
                )
                fig_day.update_traces(marker_color=colors_day, textposition='outside', texttemplate='<b>%{y}</b>')
                fig_day.update_layout(plot_bgcolor='rgba(0,0,0,0)', paper_bgcolor='rgba(0,0,0,0)', font_color='white')
                st.plotly_chart(fig_day, use_container_width=True)

        st.markdown("---")

        # ==========================================
        # Section 7: The Obsession Index
        # ==========================================
        st.header("🔥 The Obsession Index")
        st.markdown("**What makes a track an \"Obsession\"?** It’s not just about total plays. The Obsession Index (1-100) finds the tracks you can't live without _right now_. It calculates how heavily you've streamed a track (**Volume**), how consistently it appears in your daily rotation (**Density**), and penalizes tracks you've stopped playing (**Recency**).")

        obs_n_items = st.slider("Obsession Tracks to Display", min_value=5, max_value=100, value=15, step=5, key='slider_obsession')
        obsession_df = calculate_obsession(df, pd.Timestamp.today())
        obs_display = obsession_df.head(obs_n_items).reset_index(drop=True)
        obs_display.index += 1

        with st.expander("🧠 How is the Obsession Score Calculated?"):
            st.markdown("""
            The **Obsession Score (1-100)** measures how hooked you are on a track _right now_ using three main parameters:

            1. **Density (Loyalty) – 40% Weight:** Checks how consistently you return to the track by dividing unique listening days by days since discovery.
            2. **Volume (Intensity) – 35% Weight:** Measures your total streams on a logarithmic scale, ensuring massive all-time hits don't unfairly crush new favorites.
            3. **Recency (The Flame) – 25% Weight:** Applies an exponential decay factor, meaning if you stop playing a track, its score drops rapidly.
            """)
            
            if len(obsession_df) >= 3:
                track3 = obsession_df.iloc[2]
                st.markdown(f"""
                **Real Example: Your Current #3 Obsession** Let's look at **{track3['clean_track_name']}** by **{track3['canonical_artist']}**:
                
                - **The Data:** {int(track3['total_plays'])} total streams, across {int(track3['unique_days'])} unique days, discovered {int(track3['days_since_first'])} days ago, and last played just {int(track3['days_since_last'])} days ago.
                - **The Calculation:**
                    - **Density:** {int(track3['unique_days'])} active days / {int(track3['days_since_first'] + 5)} days = **{(track3['density']*100):.1f}%**
                    - **Volume:** Logarithmic value of {int(track3['total_plays'])} streams = **{(track3['volume']):.2f}**
                    - **Recency:** Exponential decay for only {int(track3['days_since_last'])} days of silence = **{(track3['recency']*100):.1f}%** retention
                - **The Formula:** We multiply each score by its weight: `({(track3['density']):.2f} × 0.40) + ({(track3['volume']):.2f} × 0.35) + ({(track3['recency']):.2f} × 0.25)`.
                
                - **Final Result:** These factors are combined and normalized against the highest and lowest scores in your all-time library. _{track3['clean_track_name']}_ lands a blazing **{track3['Obsession Score']}**! 🦋🔥
                """)

        st.dataframe(obs_display[['clean_track_name', 'canonical_artist', 'Obsession Score']].rename(
            columns={'clean_track_name': 'Track Name', 'canonical_artist': 'Artist'}
        ).style.format({"Obsession Score": "{:g}"}).set_properties(**{'text-align': 'center'}), hide_index=True, use_container_width=True)

        st.markdown("---")

        # ==========================================
        # Section 7.5: Recommended Playlist
        # ==========================================
        st.header("🎲 Recommended Playlist")
        st.markdown("A smart mix of your current obsessions and all-time favorites — reshuffled every time you click!")

        if st.button("🎲 Generate Recommended Playlist", use_container_width=False):
            full_obsession = calculate_obsession(df, pd.Timestamp.today())
            full_top_songs = df.groupby('isrc').agg(
                plays=('ts', 'count'),
                clean_track_name=('clean_track_name', 'first'),
                canonical_artist=('canonical_artist', 'first')
            ).reset_index().sort_values('plays', ascending=False).reset_index(drop=True)

            g1 = full_obsession.head(15)[['clean_track_name', 'canonical_artist']].copy()
            g1['Source'] = '🔥 Obsession'

            obs_pool = full_obsession.iloc[15:50]
            g2_size = min(15, len(obs_pool))
            g2 = obs_pool.sample(n=g2_size)[['clean_track_name', 'canonical_artist']].copy() if g2_size > 0 else pd.DataFrame(columns=['clean_track_name', 'canonical_artist', 'Source'])
            if g2_size > 0: g2['Source'] = '🔥 Obsession'

            g3 = full_top_songs.head(5)[['clean_track_name', 'canonical_artist']].copy()
            g3['Source'] = '⭐ All-Time'

            top_pool = full_top_songs.iloc[5:50]
            g4_size = min(15, len(top_pool))
            g4 = top_pool.sample(n=g4_size)[['clean_track_name', 'canonical_artist']].copy() if g4_size > 0 else pd.DataFrame(columns=['clean_track_name', 'canonical_artist', 'Source'])
            if g4_size > 0: g4['Source'] = '⭐ All-Time'

            playlist_df = pd.concat([g1, g2, g3, g4], ignore_index=True)
            playlist_df = playlist_df.drop_duplicates(subset=['clean_track_name', 'canonical_artist']).reset_index(drop=True)

            if len(playlist_df) < 50:
                existing_keys = set(zip(playlist_df['clean_track_name'], playlist_df['canonical_artist']))
                fill_pool = full_top_songs.iloc[50:100].copy()
                fill_pool = fill_pool[~fill_pool.apply(lambda r: (r['clean_track_name'], r['canonical_artist']) in existing_keys, axis=1)]
                needed = 50 - len(playlist_df)
                fill_sample = fill_pool.head(needed)[['clean_track_name', 'canonical_artist']].copy()
                fill_sample['Source'] = '⭐ All-Time'
                playlist_df = pd.concat([playlist_df, fill_sample], ignore_index=True)

            playlist_df = playlist_df.head(50).reset_index(drop=True)
            playlist_df.insert(0, '#', range(1, len(playlist_df) + 1))

            display_playlist = playlist_df.rename(columns={
                'clean_track_name': 'Track Name',
                'canonical_artist': 'Artist'
            })[['#', 'Track Name', 'Artist', 'Source']]

            st.success(f"✅ Generated a playlist of **{len(display_playlist)}** tracks!")
            st.dataframe(
                display_playlist.style.set_properties(**{'text-align': 'center'}),
                hide_index=True,
                use_container_width=True
            )

        st.markdown("---")

        # ==========================================
        # Section 8: Session Analysis
        # ==========================================
        st.header("🎧 Session Analysis")
        
        col_s_year, col_s_gap = st.columns(2)
        with col_s_year:
            available_session_years = sorted(df['ts'].dt.year.dropna().unique(), reverse=True)
            session_year_options = ["All Time"] + [int(y) for y in available_session_years]
            selected_session_year = st.selectbox("Select Year for Session Analysis:", session_year_options, key='session_year')
            
        with col_s_gap:
            session_gap_hours = st.slider("Session Gap (Hours)", min_value=1, max_value=5, value=3, step=1, key='session_gap')
            
        st.markdown(f"*A session is defined by continuous listening with no gaps larger than {session_gap_hours} hours.*")

        if selected_session_year == "All Time":
            session_df = df.copy()
        else:
            session_df = df[df['ts'].dt.year == selected_session_year].copy()
            
        # Dynamically calculate sessions based on gap
        session_df = session_df.sort_values('ts').reset_index(drop=True)
        session_df['dynamic_is_new_session'] = (session_df['time_diff'] >= pd.Timedelta(hours=session_gap_hours)) | (session_df['time_diff'].isnull())
        session_df['dynamic_session_id'] = session_df['dynamic_is_new_session'].cumsum()

        monthly_sessions = session_df.groupby('month_year')['dynamic_session_id'].nunique().reset_index()
        monthly_sessions['month_year_str'] = monthly_sessions['month_year'].astype(str)

        if not monthly_sessions.empty:
            max_session = monthly_sessions.loc[monthly_sessions['dynamic_session_id'].idxmax(), 'month_year_str']
            colors_sessions = ['#8A2BE2' if m == max_session else '#1ED760' for m in monthly_sessions['month_year_str']]

            fig_sessions = px.bar(
                monthly_sessions,
                x='month_year_str',
                y='dynamic_session_id',
                title="Total Sessions per Month" + ("" if selected_session_year == "All Time" else f" ({selected_session_year})"),
                labels={'month_year_str': 'Month', 'dynamic_session_id': 'Number of Sessions'}
            )
            fig_sessions.update_traces(marker_color=colors_sessions, textposition='outside', texttemplate='<b>%{y}</b>')
            fig_sessions.update_layout(plot_bgcolor='rgba(0,0,0,0)', paper_bgcolor='rgba(0,0,0,0)', font_color='white')
            st.plotly_chart(fig_sessions, use_container_width=True)

        st.markdown("---")

        # ==========================================
        # Section 9: Song Information (The Tracker)
        # ==========================================
        st.header("🔍 Song Information")

        song_metadata = df.drop_duplicates('isrc')[['isrc', 'clean_track_name', 'canonical_artist']]
        
        # Adding a portion of the URI to disambiguate identical names from different URIs in the dropdown
        song_list_dict = {f"{r['clean_track_name']} | {r['canonical_artist']} | {str(r['isrc']).split(':')[-1][:6]}": r['isrc'] for _, r in song_metadata.iterrows()}
        song_list_display = sorted(list(song_list_dict.keys()))

        top_song_display = ""
        if not top_song_grouped.empty:
            t_uri = top_song_grouped.index[0]
            t_row = song_metadata[song_metadata['isrc'] == t_uri].iloc[0]
            top_song_display = f"{t_row['clean_track_name']} | {t_row['canonical_artist']} | {str(t_row['isrc']).split(':')[-1][:6]}"
        
        default_song_idx = song_list_display.index(top_song_display) if top_song_display in song_list_display else 0

        selected_combo = st.selectbox("Search for a Track to Analyze:", song_list_display, index=default_song_idx)

        if selected_combo:
            selected_uri = song_list_dict[selected_combo]
            t_name = song_metadata[song_metadata['isrc'] == selected_uri]['clean_track_name'].iloc[0]
            a_name = song_metadata[song_metadata['isrc'] == selected_uri]['canonical_artist'].iloc[0]

            track_df = df[df['isrc'] == selected_uri]
            track_df_all = df_all[df_all['isrc'] == selected_uri]

            t_plays = len(track_df)
            t_hours = track_df_all['length_hours'].sum()
            rank = top_song_grouped.index.get_loc(selected_uri) + 1 if selected_uri in top_song_grouped.index else "N/A"

            st.write(f"### {t_name} by {a_name}")
            col_kpi1, col_kpi2, col_kpi3 = st.columns(3)
            col_kpi1.metric("Total Streams", f"{t_plays:,}")
            col_kpi2.metric("Total Hours", f"{t_hours:.2f} hrs")
            col_kpi3.metric("All-Time Rank", f"#{rank:,}" if isinstance(rank, int) else rank)

            st.markdown("---")
            col_chart, col_miles = st.columns([1.5, 1])

            with col_chart:
                st.write("#### 📈 The Journey")
                track_monthly = track_df.groupby('month_year').size().reset_index(name='plays')
                track_monthly['month_year_str'] = track_monthly['month_year'].astype(str)
                
                if not track_monthly.empty:
                    fig_area = px.area(
                        track_monthly, x='month_year_str', y='plays',
                        labels={'month_year_str': 'Month', 'plays': 'Streams'},
                        color_discrete_sequence=['#1DB954']
                    )
                    fig_area.update_traces(mode='lines+markers', marker=dict(size=6), line=dict(width=3))
                    fig_area.update_layout(
                        plot_bgcolor='rgba(0,0,0,0)', paper_bgcolor='rgba(0,0,0,0)', font_color='white',
                        xaxis=dict(showgrid=False), yaxis=dict(showgrid=True, gridcolor='#333333'),
                        margin=dict(l=0, r=0, t=10, b=0)
                    )
                    st.plotly_chart(fig_area, use_container_width=True)

            with col_miles:
                st.write("#### 🏆 Track Milestones")
                
                first_listen = track_df['ts'].min()
                if pd.notnull(first_listen):
                    st.info(f"**🎧 First Listen:**\n\n{first_listen.strftime('%B %d, %Y')}")
                
                daily_plays = track_df.groupby('DateOnly').size()
                if not daily_plays.empty:
                    max_day = daily_plays.idxmax()
                    max_plays = daily_plays.max()
                    st.success(f"**🔥 Busiest Day:**\n\n{max_day.strftime('%B %d, %Y')} ({max_plays} plays)")

                unique_t_days = sorted(track_df['ts'].dt.date.dropna().unique())
                curr_s, max_s = 0, 0
                max_streak_start, max_streak_end = None, None
                curr_start = None

                if unique_t_days:
                    curr_s, max_s = 1, 1
                    curr_start = unique_t_days[0]
                    max_streak_start = unique_t_days[0]
                    max_streak_end = unique_t_days[0]

                    for i in range(1, len(unique_t_days)):
                        if (unique_t_days[i] - unique_t_days[i - 1]).days == 1:
                            curr_s += 1
                        else:
                            if curr_s > max_s: 
                                max_s = curr_s
                                max_streak_start = curr_start
                                max_streak_end = unique_t_days[i - 1]
                            curr_s = 1
                            curr_start = unique_t_days[i]
                    
                    if curr_s > max_s: 
                        max_s = curr_s
                        max_streak_start = curr_start
                        max_streak_end = unique_t_days[-1]
                
                streak_text = f"{max_s} days in a row"
                if max_streak_start and max_streak_end and max_s > 1:
                    streak_text += f"\n\n*(from {max_streak_start.strftime('%d/%m/%Y')} to {max_streak_end.strftime('%d/%m/%Y')})*"
                    
                st.warning(f"**⚡ Longest Streak:**\n\n{streak_text}")

        st.markdown("---")
        
        # ==========================================
        # Section 9.5: Artist Information
        # ==========================================
        st.header("🎤 Artist Information")
        
        artist_list = sorted(df_artists['all artists'].unique().tolist())
        
        top_artist_grouped = df_artists.groupby('all artists').size().sort_values(ascending=False)
        top_artist_str = top_artist_grouped.index[0] if not top_artist_grouped.empty else ""
        default_artist_idx = artist_list.index(top_artist_str) if top_artist_str in artist_list else 0
        
        selected_artist = st.selectbox("Search for an Artist to Analyze:", artist_list, index=default_artist_idx)
        
        if selected_artist:
            art_df = df_artists[df_artists['all artists'] == selected_artist]
            art_df_all = df_artists_all[df_artists_all['all artists'] == selected_artist]
            
            a_plays = len(art_df)
            a_hours = art_df_all['length_hours'].sum()
            a_rank = top_artist_grouped.index.get_loc(selected_artist) + 1 if selected_artist in top_artist_grouped.index else "N/A"
            a_unique = art_df['isrc'].nunique()
            
            st.write(f"### {selected_artist}")
            col_kpi1, col_kpi2, col_kpi3, col_kpi4 = st.columns(4)
            col_kpi1.metric("Total Streams", f"{a_plays:,}")
            col_kpi2.metric("Total Hours", f"{a_hours:.2f} hrs")
            col_kpi3.metric("All-Time Rank", f"#{a_rank:,}" if isinstance(a_rank, int) else a_rank)
            col_kpi4.metric("✨ Unique Tracks", f"{a_unique:,}")
            
            st.markdown("---")
            col_chart_art, col_miles_art = st.columns([1.5, 1])
            
            with col_chart_art:
                st.write("#### 📈 The Journey")
                art_monthly = art_df.groupby('month_year').size().reset_index(name='plays')
                art_monthly['month_year_str'] = art_monthly['month_year'].astype(str)
                
                if not art_monthly.empty:
                    fig_area_art = px.area(
                        art_monthly, x='month_year_str', y='plays',
                        labels={'month_year_str': 'Month', 'plays': 'Streams'},
                        color_discrete_sequence=['#1ED760']
                    )
                    fig_area_art.update_traces(mode='lines+markers', marker=dict(size=6), line=dict(width=3))
                    fig_area_art.update_layout(
                        plot_bgcolor='rgba(0,0,0,0)', paper_bgcolor='rgba(0,0,0,0)', font_color='white',
                        xaxis=dict(showgrid=False), yaxis=dict(showgrid=True, gridcolor='#333333'),
                        margin=dict(l=0, r=0, t=10, b=0)
                    )
                    st.plotly_chart(fig_area_art, use_container_width=True)

            with col_miles_art:
                st.write("#### 🏆 Artist Milestones")
                
                # Artist Streak
                unique_a_days = sorted(art_df['ts'].dt.date.dropna().unique())
                a_curr_s, a_max_s = 0, 0
                a_max_start, a_max_end = None, None
                a_curr_start = None

                if unique_a_days:
                    a_curr_s, a_max_s = 1, 1
                    a_curr_start = unique_a_days[0]
                    a_max_start = unique_a_days[0]
                    a_max_end = unique_a_days[0]

                    for i in range(1, len(unique_a_days)):
                        if (unique_a_days[i] - unique_a_days[i - 1]).days == 1:
                            a_curr_s += 1
                        else:
                            if a_curr_s > a_max_s: 
                                a_max_s = a_curr_s
                                a_max_start = a_curr_start
                                a_max_end = unique_a_days[i - 1]
                            a_curr_s = 1
                            a_curr_start = unique_a_days[i]
                    
                    if a_curr_s > a_max_s: 
                        a_max_s = a_curr_s
                        a_max_start = a_curr_start
                        a_max_end = unique_a_days[-1]
                
                a_streak_text = f"{a_max_s} days in a row"
                if a_max_start and a_max_end and a_max_s > 1:
                    a_streak_text += f"\n\n*(from {a_max_start.strftime('%d/%m/%Y')} to {a_max_end.strftime('%d/%m/%Y')})*"
                    
                st.warning(f"**⚡ Longest Streak:**\n\n{a_streak_text}")

        st.markdown("---")

        # ==========================================
        # Section 10: Fun Facts & Time Travel
        # ==========================================
        st.header("💡 Fun Facts & Time Travel")

        time_travel_date_all = df_all['DateOnly'].max()
        time_travel_date = time_travel_date_all - pd.Timedelta(days=365) if pd.notnull(time_travel_date_all) else min_date

        st.subheader(f"🕰️ Today, 1 Year Ago ({time_travel_date.strftime('%d/%m/%Y')})")

        tt_df = df_all[df_all['DateOnly'] == time_travel_date]
        tt_df_valid = df[df['DateOnly'] == time_travel_date]

        if not tt_df.empty:
            tt_hours = tt_df['length_hours'].sum()
            tt_plays = len(tt_df_valid)

            history_tt = raw_df[raw_df['DateOnly'] <= time_travel_date]
            obs_tt = calculate_obsession(history_tt, time_travel_date)

            top_tt_song = "N/A"
            if not obs_tt.empty:
                top_tt_song = f"{obs_tt.iloc[0]['clean_track_name']} by {obs_tt.iloc[0]['canonical_artist']} (Score: {obs_tt.iloc[0]['Obsession Score']})"

            text_tt = f"**Total Streams:** {tt_plays:,}  |  **Total Time:** {tt_hours:.2f} hrs  |  **#1 Obsession That Day:** {top_tt_song}"
            st.info(text_tt, icon="ℹ️")
        else:
            st.info(f"No listening history recorded for exactly 1 year ago ({time_travel_date.strftime('%d/%m/%Y')}).")

        st.write("")

        unique_days = sorted(df['ts'].dt.date.dropna().unique())
        current_streak = 0
        max_streak = 0
        streak_start_date = None
        max_streak_start = None
        max_streak_end = None

        if unique_days:
            current_streak = 1
            max_streak = 1
            streak_start_date = unique_days[0]
            max_streak_start = unique_days[0]
            max_streak_end = unique_days[0]

            for i in range(1, len(unique_days)):
                if (unique_days[i] - unique_days[i - 1]).days == 1:
                    current_streak += 1
                else:
                    if current_streak > max_streak:
                        max_streak = current_streak
                        max_streak_start = streak_start_date
                        max_streak_end = unique_days[i - 1]
                    current_streak = 1
                    streak_start_date = unique_days[i]

            if current_streak > max_streak:
                max_streak = current_streak
                max_streak_start = streak_start_date
                max_streak_end = unique_days[-1]

        top_art_time = df_artists_all.groupby('all artists')['length_hours'].sum().idxmax()
        top_art_time_val = df_artists_all.groupby('all artists')['length_hours'].sum().max()

        top_song_fact = top_song_name if not top_song_grouped.empty else "N/A"
        top_song_fact_plays = top_song_plays if not top_song_grouped.empty else 0

        most_active_date = df_all.groupby('DateOnly')['length_hours'].sum().idxmax()
        most_active_date_val = df_all.groupby('DateOnly')['length_hours'].sum().max()

        best_month = df_all.groupby('month_year')['length_hours'].sum().idxmax()
        best_month_val = df_all.groupby('month_year')['length_hours'].sum().max()



        first_song_row = df.loc[df['ts'].idxmin()]
        first_song_name = first_song_row['clean_track_name']
        first_song_date = first_song_row['ts'].strftime('%Y-%m-%d')

        most_diverse_art = df_artists.groupby('all artists')['isrc'].nunique().idxmax()
        most_diverse_count = df_artists.groupby('all artists')['isrc'].nunique().max()

        streak_c1, streak_c2 = st.columns(2)
        streak_c1.success(f"**⚡ Current Streak:**\n\n {current_streak} Days")

        if max_streak_start and max_streak_end:
            streak_text = f"{max_streak} Days (From {max_streak_start.strftime('%d/%m/%Y')} to {max_streak_end.strftime('%d/%m/%Y')})"
        else:
            streak_text = f"{max_streak} Days"
        streak_c2.warning(f"**🔥 Longest Streak:**\n\n {streak_text}")

        st.write("")

        fact_c1, fact_c2, fact_c3, fact_c4 = st.columns(4)
        fact_c1.info(f"**🏆 Top Artist:**\n\n {top_art_time} ({top_art_time_val:.0f} hrs)")
        fact_c2.success(f"**🎯 Top Track:**\n\n {top_song_fact} ({top_song_fact_plays} plays)")
        fact_c3.warning(f"**📈 Busiest Day:**\n\n {most_active_date.strftime('%Y-%m-%d')} ({most_active_date_val:.1f} hrs)")
        fact_c4.error(f"**📅 Best Month:**\n\n {best_month} ({best_month_val:.0f} hrs)")

        st.write("")

        fact_c5, fact_c6 = st.columns(2)
        fact_c5.success(f"**🎵 First Track:**\n\n '{first_song_name}' on {first_song_date}.")
        fact_c6.info(f"**🎭 Most Diverse Artist:**\n\n {most_diverse_art} ({most_diverse_count} unique tracks)")
        
        st.markdown("<br><br><center>Built with ❤️ using Python, Streamlit & Data Science</center>",
                    unsafe_allow_html=True)