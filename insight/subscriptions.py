import uuid
from datetime import datetime, timezone
KINDS={'event','region','domain','metric'}
DOMAIN_BY_TYPE={'sales_decline':'销售业务域','margin_drop':'毛利业务域','ar_overdue':'应收业务域','target_gap':'目标业务域'}
def _now(): return datetime.now(timezone.utc).isoformat()
def _id(p): return p+'-'+str(uuid.uuid4())
def list_subscriptions(db,user): return [dict(r) for r in db.execute('SELECT * FROM insight_subscription WHERE user_id=? ORDER BY created_at DESC',(user,))]
def add_subscription(db,user,kind,value,label=None):
    if kind not in KINDS or not isinstance(value,str) or not value.strip(): raise ValueError('invalid subscription')
    now=_now(); value=value.strip(); label=(label or value).strip(); row=db.execute('SELECT * FROM insight_subscription WHERE user_id=? AND kind=? AND value=?',(user,kind,value)).fetchone()
    if row: db.execute('UPDATE insight_subscription SET enabled=1,label=?,updated_at=? WHERE id=?',(label,now,row['id'])); db.commit(); return dict(db.execute('SELECT * FROM insight_subscription WHERE id=?',(row['id'],)).fetchone())
    sid=_id('sub'); db.execute('INSERT INTO insight_subscription VALUES (?,?,?,?,?,?,?,?)',(sid,user,kind,value,label,1,now,now)); db.commit(); return dict(db.execute('SELECT * FROM insight_subscription WHERE id=?',(sid,)).fetchone())
def remove_subscription(db,user,sid):
    c=db.execute('UPDATE insight_subscription SET enabled=0,updated_at=? WHERE id=? AND user_id=?',(_now(),sid,user)); db.commit(); return c.rowcount==1
def list_notifications(db,user,unread=False):
    q='SELECT * FROM insight_notification WHERE user_id=?'+(' AND read_at IS NULL' if unread else '')+' ORDER BY created_at DESC LIMIT 200'; return [dict(r) for r in db.execute(q,(user,))]
def mark_read(db,user,nid=None):
    c=db.execute('UPDATE insight_notification SET read_at=? WHERE user_id=?'+(' AND id=?' if nid else ' AND read_at IS NULL'), ((_now(),user,nid) if nid else (_now(),user))); db.commit(); return c.rowcount

def matches(db,user):
    import json
    subs=[dict(r) for r in db.execute('SELECT * FROM insight_subscription WHERE user_id=? AND enabled=1',(user,))]
    out=[]
    for ev in db.execute('SELECT * FROM business_event ORDER BY created_at DESC LIMIT 500'):
        try: scope=json.loads(ev['scope_json'] or '{}')
        except (TypeError,ValueError): scope={}
        org=str(scope.get('组织节点','')); domain=DOMAIN_BY_TYPE.get(ev['event_type'],ev['event_type']); hits=[s for s in subs if (s['kind']=='event' and s['value']==ev['event_id']) or (s['kind']=='region' and s['value'] in org) or (s['kind']=='domain' and s['value'] in (domain,ev['event_type'])) or (s['kind']=='metric' and s['value'] in (ev['event_type'],ev['metric']))]
        if hits: out.append({'event':dict(ev),'matchedSubscriptions':hits})
    return out

def dispatch_event(db, ev, change='created'):
    """Best-effort fanout; duplicate deliveries are ignored by the unique key."""
    import json
    try: org=str(json.loads(ev['scope_json'] or '{}').get('组织节点',''))
    except (TypeError,ValueError): org=''
    domain=DOMAIN_BY_TYPE.get(ev['event_type'],ev['event_type'])
    users={s['user_id'] for s in db.execute('SELECT * FROM insight_subscription WHERE enabled=1') if (s['kind']=='event' and s['value']==ev['event_id']) or (s['kind']=='region' and s['value'] in org) or (s['kind']=='domain' and s['value'] in (domain,ev['event_type'])) or (s['kind']=='metric' and s['value'] in (ev['event_type'],ev['metric']))}
    for user in users: db.execute('INSERT OR IGNORE INTO insight_notification VALUES (?,?,?,?,?,?,?,?,?)',(_id('note'),user,ev['event_id'],change,ev['title'],ev['summary'],ev['severity'],_now(),None))
    db.commit(); return len(users)
