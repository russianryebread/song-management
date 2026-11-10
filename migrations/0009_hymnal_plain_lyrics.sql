UPDATE trusted_sources
SET lyrics_selector = '.hymn-content .js-stanzas > .verse:not(.js-duplicate-row):not(.hidden) > .verse-num, .hymn-content .js-stanzas > .verse:not(.js-duplicate-row):not(.hidden) > .text-container'
WHERE lower(rtrim(base_url, '/')) IN ('https://hymnal.net', 'https://www.hymnal.net')
  AND lyrics_selector = '.hymn-content';
