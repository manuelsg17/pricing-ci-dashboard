import { createClient } from '@supabase/supabase-js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const env = fs.readFileSync(path.join(__dirname, '.env.local'), 'utf-8');
const url = env.match(/VITE_SUPABASE_URL=(.*)/)[1].trim();
const key = env.match(/VITE_SUPABASE_ANON_KEY=(.*)/)[1].trim();

const sb = createClient(url, key);

async function check() {
  const { data, error } = await sb.from('distance_thresholds')
    .select('*')
    .eq('city', 'Lima')
    .eq('category', 'Economy')
    .order('max_km', { ascending: true });
  
  if (error) {
    console.error(error);
    return;
  }
  
  console.log('Thresholds for Lima Economy:');
  console.log(data);
}

check();
