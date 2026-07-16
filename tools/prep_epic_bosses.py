#!/usr/bin/env python3
"""Compatibility entry point for the complete Epic Boss asset exporter.

The historical script exported only Dr. Groundhog. Keep its familiar command name,
but delegate to the all-boss pipeline so running it cannot leave generated assets in
a partially refreshed state.
"""

from prep_all_epic_bosses import main


if __name__ == "__main__":
    main()
