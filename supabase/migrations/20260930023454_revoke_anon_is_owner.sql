-- Signed-out visitors have no reason to call is_owner() through the API.
revoke execute on function public.is_owner() from anon;
