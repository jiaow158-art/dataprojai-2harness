from insight.db import open_db
from insight.subscriptions import add_subscription, list_subscriptions, remove_subscription, list_notifications, mark_read, dispatch_event
from insight.store import Store
from insight.merge_rank import update_episodes

def test_subscription_is_user_scoped_and_duplicate_reactivates(tmp_path):
    db=open_db(tmp_path/'s.db')
    a=add_subscription(db,'alice','region','华南','华南运营中心')
    assert len(list_subscriptions(db,'alice'))==1
    add_subscription(db,'alice','region','华南','华南运营中心')
    assert len(list_subscriptions(db,'alice'))==1
    assert list_subscriptions(db,'bob')==[]
    assert remove_subscription(db,'bob',a['id']) is False
    assert remove_subscription(db,'alice',a['id']) is True
    assert list_subscriptions(db,'alice')[0]['enabled']==0

def test_notification_read_state(tmp_path):
    db=open_db(tmp_path/'n.db')
    db.execute("INSERT INTO insight_notification VALUES ('n1','alice','ev1','created','title','summary','minor','2026-01-01',NULL)")
    db.commit()
    assert len(list_notifications(db,'alice',True))==1
    assert mark_read(db,'alice','n1')==1
    assert list_notifications(db,'alice',True)==[]

def test_dispatch_matches_all_subscription_kinds(tmp_path):
    db=open_db(tmp_path/'d.db')
    values={'event':'ev-1','region':'华南','domain':'销售业务域','metric':'yoy'}
    for i,(kind,value) in enumerate(values.items()): add_subscription(db,f'u{i}',kind,value,value)
    ev={'event_id':'ev-1','event_type':'sales_decline','metric':'yoy','scope_json':'{"组织节点":"华南|GD01"}','title':'异常','summary':'下降','severity':'major'}
    assert dispatch_event(db,ev)==4
    assert dispatch_event(db,ev)==4
    assert db.execute('SELECT COUNT(*) c FROM insight_notification').fetchone()['c']==4

def test_store_dispatches_created_and_resolved_without_changing_event_flow(tmp_path):
    s=Store(open_db(tmp_path/'flow.db')); add_subscription(s.db,'alice','region','华南','华南')
    finding={'finding_id':'f1','data_date':'2026-09-01','detector':'region_sales','dim_keys':{'anchor_type':'org_channel','anchor_id':'华南|GD01','channel':'GD01'},'metrics':{'yoy_pct':-12,'impact_wan':100},'norm_score':90}
    update_episodes(s,'2026-09-01',[finding])
    assert [n['kind'] for n in list_notifications(s.db,'alice')]==['created']
    update_episodes(s,'2026-09-05',[])
    assert {n['kind'] for n in list_notifications(s.db,'alice')}=={'created','resolved'}
