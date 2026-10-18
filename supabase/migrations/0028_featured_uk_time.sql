-- Featured spots run on UK days: a spot ends at midnight UK time after its
-- last day, which is what the countdown in the app shows.
alter function food.featured_shops() set timezone = 'Europe/London';
alter function food.request_promotion(int) set timezone = 'Europe/London';
alter function food.admin_promotions() set timezone = 'Europe/London';
alter function food.admin_decide_promotion(uuid, text, text) set timezone = 'Europe/London';
alter function food.promo_next_start(int) set timezone = 'Europe/London';
alter function food.my_promotion_queue() set timezone = 'Europe/London';
