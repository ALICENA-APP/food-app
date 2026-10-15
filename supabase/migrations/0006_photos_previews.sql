-- Removing a photo needs read access to it as well as delete access.
create policy "product images: shop owner reads" on storage.objects
  for select to authenticated
  using (bucket_id = 'product-images'
         and food.owns_shop(((storage.foldername(name))[1])::uuid));
