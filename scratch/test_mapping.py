"""
בדיקת המיפוי - האם הלוגיקה המקומית עובדת נכון?
"""
import pandas as pd

# סימולציה של נתוני Gravity | Martin Garrix עם 4 URIs שונים
df = pd.DataFrame({
    'clean_track_name': ['Gravity', 'Gravity', 'Gravity', 'Gravity', 'Empty', 'Empty'],
    'canonical_artist': ['Martin Garrix', 'Martin Garrix', 'Martin Garrix', 'Martin Garrix', 'DubVision', 'Martin Garrix'],
    'spotify_track_uri': ['uri:aaa', 'uri:bbb', 'uri:ccc', 'uri:ddd', 'uri:eee', 'uri:fff']
})

# בדיקת ה"פילטר החכם" - אוספים זוגות ייחודיים
name_uri_counts = df.groupby('clean_track_name')['spotify_track_uri'].nunique()
duplicate_names = name_uri_counts[name_uri_counts > 1].index
suspected_duplicates_df = df[df['clean_track_name'].isin(duplicate_names)]
unique_pairs = suspected_duplicates_df[['clean_track_name', 'canonical_artist']].drop_duplicates().values.tolist()

print("Unique pairs to query Spotify:")
for p in unique_pairs:
    print(f"  {p}")

# סימולציה של תוצאות מספוטיפיי - הם מחזירים ISRC אחד לכל חיפוש
pair_to_isrc = {
    ('Gravity', 'Martin Garrix'): 'USRC_GRAVITY_001',
    ('Empty', 'DubVision'): 'USRC_EMPTY_001',
    ('Empty', 'Martin Garrix'): 'USRC_EMPTY_001',  # ספוטיפיי מחזיר אותו ISRC לשני הגרסאות
}

# השיטה הנוכחית בקוד
pair_series = pd.Series(list(zip(df['clean_track_name'], df['canonical_artist'])))
df['isrc'] = pair_series.map(pair_to_isrc).fillna(pd.Series(df['spotify_track_uri'].values)).values

print("\nResult (should have NO duplicates per song):")
print(df[['clean_track_name', 'canonical_artist', 'spotify_track_uri', 'isrc']])

print("\nSong Information dropdown (drop_duplicates by isrc):")
song_metadata = df.drop_duplicates('isrc')[['isrc', 'clean_track_name', 'canonical_artist']]
print(song_metadata)
print(f"\nTotal unique songs: {df['isrc'].nunique()} (expected 2)")
