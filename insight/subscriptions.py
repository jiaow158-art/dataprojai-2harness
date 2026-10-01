import uuid
from datetime import datetime, timezone
KINDS={'event','region','domain','metric'}
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
