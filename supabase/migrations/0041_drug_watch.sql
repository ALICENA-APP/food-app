-- Early warning for drug dealing: chats, "Ask the cook" questions, shop
-- pages and dishes that use drug words or slang are flagged to
-- Admin > Safety (source 'drug watch'). Messages still go through, because
-- some slang is also everyday language; this is for a human to look at.

create or replace function food.drug_words(p text) returns text
language plpgsql immutable set search_path = '' as $$
declare
  s text := food.squash_words(p);
  w text;
begin
  if p ~ '[💊🔌]' then return 'drug emoji'; end if;
  foreach w in array array['cocaine', 'coke deal', 'crack cocaine', 'crack rock', 'heroin', 'meth', 'mdma', 'ecstasy', 'ketamine', 'ket',
      'xanax', 'xans', 'valium', 'diazepam', 'oxycodone', 'codeine', 'purple drank', 'lsd', 'shrooms', 'psilocybin',
      'weed', 'ganja', 'skunk', 'kush', 'cannabis', 'marijuana', 'thc', 'spliff', 'zoot', 'edibles',
      'nangs', 'laughing gas', 'nos canisters', 'the plug', 'my plug', 'your plug', 'plug for', 'dealer', 'baggie', 'baggies',
      'pills for sale'] loop
    if s ~ food.word_pattern(replace(w, ' ', '')) then return 'possible drug words: ' || w; end if;
  end loop;
  return null;
end $$;
grant execute on function food.drug_words(text) to authenticated;

create or replace function food.watch_for_drugs() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v text;
  v_shop uuid;
  v_order uuid;
  v_product uuid;
  v_text text;
  v_source text;
begin
  if tg_table_name = 'order_messages' then
    v_text := new.body; v_order := new.order_id; v_source := 'drug watch: order chat';
    select shop_id into v_shop from food.orders where id = new.order_id;
  elsif tg_table_name = 'shop_chat_messages' then
    v_text := new.body; v_source := 'drug watch: question chat';
    select shop_id into v_shop from food.shop_chats where id = new.chat_id;
  elsif tg_table_name = 'products' then
    v_text := concat_ws(' ', new.name, new.description, new.ingredients); v_shop := new.shop_id; v_product := new.id; v_source := 'drug watch: dish';
  else
    v_text := concat_ws(' ', new.name, new.story, new.notice); v_shop := new.id; v_source := 'drug watch: shop page';
  end if;
  v := food.drug_words(v_text);
  if v is not null then
    insert into food.safety_flags (user_id, shop_id, order_id, product_id, source, reason, excerpt)
    values (auth.uid(), v_shop, v_order, v_product, v_source, left(v, 80), left(v_text, 300));
  end if;
  return null;
end $$;

create trigger order_messages_drug_watch after insert on food.order_messages
  for each row execute function food.watch_for_drugs();
create trigger shop_chat_messages_drug_watch after insert on food.shop_chat_messages
  for each row when (new.sender_id is not null) execute function food.watch_for_drugs();
create trigger products_drug_watch after insert or update of name, description, ingredients on food.products
  for each row execute function food.watch_for_drugs();
create trigger shops_drug_watch after insert or update of name, story, notice on food.shops
  for each row execute function food.watch_for_drugs();

-- Demo: what a drug warning looks like in Admin > Safety.
insert into food.safety_flags (shop_id, source, reason, excerpt, created_at)
select id, 'drug watch: question chat', 'possible drug words: plug', 'Are you the plug? Need some kush with the order (demo: an example warning)', now() - interval '2 hours'
  from food.shops where slug = 'demo-meis-dumplings';
