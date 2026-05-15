import pandas as pd
import numpy as np

df = pd.DataFrame({
    'clean_track_name': ['Empty', 'Empty', 'Gravity', 'Gravity', 'Other'],
    'canonical_artist': ['Martin Garrix', 'DubVision', 'Martin Garrix', 'Martin Garrix', 'Artist'],
    'spotify_track_uri': ['uri1', 'uri2', 'uri3', 'uri4', 'uri5']
})

pair_to_isrc = {
    ('Empty', 'Martin Garrix'): 'ISRC1',
    ('Empty', 'DubVision'): 'ISRC1',
    ('Gravity', 'Martin Garrix'): 'ISRC2'
}

df['isrc'] = [pair_to_isrc.get((t, a), u) for t, a, u in zip(df['clean_track_name'], df['canonical_artist'], df['spotify_track_uri'])]
print(df)
