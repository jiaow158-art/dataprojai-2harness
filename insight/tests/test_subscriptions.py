from insight.db import open_db
from insight.subscriptions import add_subscription, list_subscriptions, remove_subscription, list_notifications, mark_read

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
