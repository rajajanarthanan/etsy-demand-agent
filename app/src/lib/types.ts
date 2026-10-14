export type ListingExample = {
  title: string;
  url: string;
  price: number | null;
  rank: number | null;
  market_score: number | null;
  reviews_last_30d: number | null;
  reviews_last_90d: number | null;
};

export type ProductTypeBucket = {
  category: string;
  noise_points: number;
  listing_count: number;
  reviews_last_30d_sum: number;
  median_price: number | null;
  makeable: boolean;
  examples: ListingExample[];
};

export type MarketSlice = {
  listing_count: number;
  product_types: ProductTypeBucket[];
  top_listings: ListingExample[];
};

export type Wave1Row = {
  category: string;
  combined_noise: number;
  us_noise: number | null;
  ca_noise: number | null;
  us_median_price: number | null;
  ca_median_price: number | null;
  us_reviews_30d: number | null;
  ca_reviews_30d: number | null;
  example_us: ListingExample | null;
  example_ca: ListingExample | null;
};

export type MarketDemandSummary = {
  source: {
    harvest_rows: number;
    unique_harvest: number;
    products: number;
    shops: number;
  };
  us: MarketSlice;
  ca: MarketSlice;
  wave1_makeable_shortlist: Wave1Row[];
  seller_intel: {
    products_with_ships_from: number;
    shops_with_location: number;
    ships_from_top: { origin: string; listings: number }[];
    shop_location_top: { location: string; shops: number }[];
  };
  scoring_notes: string;
};

export type DeskSecrets = {
  openaiApiKey?: string;
  scrapeOpsApiKey?: string;
  dataimpulse?: {
    login?: string;
    password?: string;
    host?: string;
    port?: number;
  };
};

export type BusinessMemory = {
  brand?: string;
  materials: string[];
  wave1_categories: string[];
  prefer: string[];
  avoid: string[];
  compliance_notes: string[];
  scoring_caveats: string[];
};

export type MemoryNote = {
  id: string;
  created_at: string;
  text: string;
  tags?: string[];
  category?: string;
  run_id?: string;
};

export type SyncStatus = {
  running: boolean;
  phase: "idle" | "harvest" | "deep" | "summarize" | "reindex" | "done" | "error";
  message: string;
  started_at?: string;
  finished_at?: string;
  pid?: number;
  error?: string;
};
