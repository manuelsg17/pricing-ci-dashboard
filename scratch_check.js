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
  const { data, error } = await sb.from('pricing_observations')
    .select('category, count()', { count: 'exact' })
    .eq('city', 'Arequipa');
  
  const { data: all } = await sb.from('pricing_observations').select('category').eq('city', 'Arequipa');
  
  const cats = {};
  all?.forEach(r => {
    cats[r.category] = (cats[r.category] || 0) + 1;
  });
  
  console.log('Actual Category strings in DB for Arequipa:');
  console.log(cats);
}

check();
