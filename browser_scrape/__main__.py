"""Allow `python -m browser_scrape.worker` style entrypoints."""
from __future__ import annotations

import sys

from .worker import main

if __name__ == "__main__":
    main(sys.argv[1:])
