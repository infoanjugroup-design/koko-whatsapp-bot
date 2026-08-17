import { proto, initAuthCreds, BufferJSON } from '@whiskeysockets/baileys';
import supabase from './supabase.js';

export async function useSupabaseAuthState(sessionId = 'default-session') {
  // 1. Fetch credentials from DB
  const { data: credsRow, error: credsError } = await supabase
    .from('sessions')
    .select('value')
    .eq('session_id', sessionId)
    .eq('key', 'creds')
    .maybeSingle();

  if (credsError) {
    console.error('❌ Error fetching creds from Supabase:', credsError);
  }

  // Parse creds or initialize fresh
  let creds;
  if (credsRow?.value) {
    try {
      creds = JSON.parse(JSON.stringify(credsRow.value), BufferJSON.reviver);
    } catch (e) {
      console.warn('⚠️ Corrupted creds JSON, initializing fresh...');
      creds = initAuthCreds();
    }
  } else {
    creds = initAuthCreds();
  }

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {};
          if (!ids || ids.length === 0) return data;

          const keysToFetch = ids.map((id) => `${type}-${id}`);
          const { data: rows, error } = await supabase
            .from('sessions')
            .select('key, value')
            .eq('session_id', sessionId)
            .in('key', keysToFetch);

          if (error) {
            console.error(`❌ Error fetching keys for ${type}:`, error);
            return data;
          }

          for (const row of rows || []) {
            const rawId = row.key.replace(`${type}-`, '');
            try {
              let parsed = JSON.parse(JSON.stringify(row.value), BufferJSON.reviver);
              if (type === 'app-state-sync-key' && parsed) {
                parsed = proto.Message.AppStateSyncKeyData.fromObject(parsed);
              }
              data[rawId] = parsed;
            } catch (err) {
              console.error(`Error parsing key ${row.key}:`, err);
            }
          }
          return data;
        },

        set: async (data) => {
          const tasks = [];

          for (const category in data) {
            for (const id in data[category]) {
              const value = data[category][id];
              const key = `${category}-${id}`;

              if (value) {
                const serialized = JSON.parse(JSON.stringify(value, BufferJSON.replacer));
                tasks.push(
                  supabase.from('sessions').upsert(
                    {
                      session_id: sessionId,
                      key,
                      value: serialized,
                      updated_at: new Date().toISOString(),
                    },
                    { onConflict: 'session_id,key' }
                  )
                );
              } else {
                tasks.push(
                  supabase
                    .from('sessions')
                    .delete()
                    .eq('session_id', sessionId)
                    .eq('key', key)
                );
              }
            }
          }

          await Promise.all(tasks);
        },
      },
    },

    saveCreds: async () => {
      const serializedCreds = JSON.parse(JSON.stringify(creds, BufferJSON.replacer));
      const { error } = await supabase.from('sessions').upsert(
        {
          session_id: sessionId,
          key: 'creds',
          value: serializedCreds,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'session_id,key' }
      );

      if (error) {
        console.error('❌ Failed to persist creds to Supabase:', error);
      }
    },
  };
}
