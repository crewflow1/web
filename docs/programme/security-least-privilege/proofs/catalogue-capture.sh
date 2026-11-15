#!/bin/bash
# capture.sh <label> — snapshot the authorisation-relevant catalogue of schema public as JSON
L=$1; D=$(dirname "$0")
q() { psql "$DATABASE_URL" -At -c "$1"; }
q "select coalesce(json_agg(json_build_object('t',tablename,'n',policyname,'perm',permissive,'roles',roles,'cmd',cmd,'qual',qual,'chk',with_check) order by tablename,policyname),'[]') from pg_policies where schemaname='public'" > $D/$L.policies.json
q "select coalesce(json_agg(json_build_object('t',c.relname,'n',t.tgname,'def',pg_get_triggerdef(t.oid)) order by c.relname,t.tgname),'[]') from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and not t.tgisinternal" > $D/$L.triggers.json
q "select coalesce(json_agg(json_build_object('sig',p.oid::regprocedure::text,'def',pg_get_functiondef(p.oid),'acl',p.proacl::text,'comment',obj_description(p.oid,'pg_proc')) order by p.oid::regprocedure::text),'[]') from pg_proc p where p.pronamespace='public'::regnamespace and p.prokind in ('f','p')" > $D/$L.functions.json
q "select coalesce(json_agg(json_build_object('t',table_name,'g',grantee,'p',privilege_type) order by table_name,grantee,privilege_type),'[]') from information_schema.role_table_grants where table_schema='public' and grantee in ('anon','authenticated')" > $D/$L.tgrants.json
q "select coalesce(json_agg(json_build_object('t',table_name,'c',column_name,'g',grantee,'p',privilege_type) order by table_name,column_name,grantee,privilege_type),'[]') from information_schema.column_privileges where table_schema='public' and grantee in ('anon','authenticated')" > $D/$L.cgrants.json
pg_dump "$DATABASE_URL" --schema-only -n public --no-owner 2>/dev/null | grep -vE "^(--|SET |SELECT pg_catalog|\\\\(un)?restrict)" > $D/$L.dump.sql
wc -c $D/$L.*.json $D/$L.dump.sql | tail -1
