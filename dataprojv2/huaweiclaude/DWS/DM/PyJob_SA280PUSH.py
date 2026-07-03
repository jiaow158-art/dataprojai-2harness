# -*- coding: utf-8 -*-

## PYTHON 
## ******************************************************************** ##
## author: DP_15000571
## create time: 2026/05/16 08:53:34 GMT+08:00
## description:经营简报文案推送脚本 每日九点推送
## history list:   r'/home/dp-user/upload/SA280report.sql'
## UPDATE FROM 15000571 时间<年月日> 修改描述内容
## ******************************************************************** -- --
import re
import sys
import argparse
import logging
from datetime import date, timedelta

import psycopg2
import requests


# =========================
# 1. 本地配置区：你主要改这里
# =========================

PG_CONFIG = {
    "host": "121.37.200.214",        # PGSQL地址，例如 127.0.0.1 或 10.xx.xx.xx
    "port": 8000,               # PGSQL端口
    "dbname": "DP_DWS",  # 数据库名
    "user": "dppy_sjyy_user",        # 用户名
    "password": "Dp@123456" # 密码
}

WECOM_WEBHOOK_URL = "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=2dd7ad7e-0919-435d-997e-c8c72a1eef0e"

# SQL文件路径
DEFAULT_SQL_FILE =r'/home/dp-user/upload/SA280report.sql'

# 推荐用 markdown，展示效果比 text 好
# 可选：text / markdown
DEFAULT_MSG_TYPE = "markdown"


# =========================
# 2. 日志配置
# =========================

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s"
)


def parse_args():
    parser = argparse.ArgumentParser(description="本地执行PGSQL SQL并推送到企业微信")
    parser.add_argument(
        "--sql-file",
        default=DEFAULT_SQL_FILE,
        help="SQL文件路径，默认 report.sql"
    )
    parser.add_argument(
        "--biz-date",
        default=None,
        help="业务日期，例如 2026-05-14；不传默认昨天"
    )
    parser.add_argument(
        "--msgtype",
        default=DEFAULT_MSG_TYPE,
        choices=["text", "markdown"],
        help="企业微信消息类型：text 或 markdown，默认 markdown"
    )
    parser.add_argument(
        "--only-test-wecom",
        action="store_true",
        help="只测试企业微信推送，不执行SQL"
    )
    parser.add_argument(
        "--only-test-db",
        action="store_true",
        help="只测试数据库连接，不推送企业微信"
    )
    return parser.parse_args()


def get_biz_date(input_date=None):
    """
    如果命令行传了 --biz-date，则使用传入日期；
    否则默认使用昨天。
    """
    if input_date:
        return input_date

    yesterday = date.today() - timedelta(days=1)
    return yesterday.strftime("%Y-%m-%d")


def load_sql(sql_file, biz_date):
    """
    读取SQL文件，并替换业务日期。
    """
    logging.info("读取SQL文件：%s", sql_file)

    with open(sql_file, "r", encoding="utf-8") as f:
        sql = f.read()

    # 兼容从文档复制出来的 **select**、**case** 这种加粗标记
    sql = sql.replace("**", "")

    # 推荐SQL里面写 '${biz_date}'::date
    placeholder = "$" + "{biz_date}"
    sql = sql.replace(placeholder, biz_date)


    return sql


def get_pg_conn():
    """
    获取PGSQL连接。
    """
    return psycopg2.connect(
        host=PG_CONFIG["host"],
        port=PG_CONFIG["port"],
        dbname=PG_CONFIG["dbname"],
        user=PG_CONFIG["user"],
        password=PG_CONFIG["password"],
        connect_timeout=20
    )


def test_db_connection():
    """
    测试数据库连接。
    """
    conn = None
    try:
        conn = get_pg_conn()
        with conn.cursor() as cur:
            cur.execute("select now();")
            result = cur.fetchone()
            logging.info("数据库连接成功，当前数据库时间：%s", result[0])
    finally:
        if conn:
            conn.close()


def run_sql(sql):
    """
    执行SQL，取第一行第一列作为企业微信推送内容。
    """
    conn = None
    try:
        conn = get_pg_conn()
        conn.autocommit = True

        with conn.cursor() as cur:
            logging.info("开始执行SQL...")
            cur.execute(sql)

            row = cur.fetchone()

            if not row:
                logging.warning("SQL执行成功，但没有返回结果")
                return "SQL执行成功，但没有返回结果。"

            msg = row[0]

            if msg is None:
                logging.warning("SQL执行成功，但第一列为空")
                return "SQL执行成功，但返回内容为空。"

            logging.info("SQL执行完成")
            return str(msg)

    finally:
        if conn:
            conn.close()


def clean_content(content, msgtype="markdown"):
    """
    清理SQL返回的内容。
    你的SQL里用了 <br> 和 <b>，这里做一下兼容。
    """
    if content is None:
        return ""

    content = str(content)

    if msgtype == "text":
        # text消息不会渲染HTML，所以转成普通文本
        content = content.replace("<br>", "\n")
        content = content.replace("<br/>", "\n")
        content = content.replace("<br />", "\n")
        content = content.replace("<b>", "")
        content = content.replace("</b>", "")

        # 清除其它HTML标签
        content = re.sub(r"<[^>]+>", "", content)

    elif msgtype == "markdown":
        # markdown中用换行和加粗
        content = content.replace("<br>", "\n")
        content = content.replace("<br/>", "\n")
        content = content.replace("<br />", "\n")
        content = content.replace("<b>", "**")
        content = content.replace("</b>", "**")

    return content.strip()


def send_wecom_message(content, msgtype="markdown"):
    """
    推送企业微信机器人。

    该版本不分页、不拆分，直接整条消息推送。
    """
    if not WECOM_WEBHOOK_URL:
        raise RuntimeError("WECOM_WEBHOOK_URL 不能为空")

    content = clean_content(content, msgtype)

    if not content:
        content = "推送内容为空。"

    content_bytes = len(content.encode("utf-8"))
    logging.info("准备推送企业微信，消息字符数：%s，UTF-8字节数：%s", len(content), content_bytes)

    if msgtype == "text":
        payload = {
            "msgtype": "text",
            "text": {
                "content": content
            }
        }
    elif msgtype == "markdown":
        payload = {
            "msgtype": "markdown",
            "markdown": {
                "content": content
            }
        }
    else:
        raise ValueError(f"不支持的消息类型：{msgtype}")

    logging.info("开始推送企业微信消息，不分页，整条推送")

    response = requests.post(
        WECOM_WEBHOOK_URL,
        json=payload,
        timeout=30
    )

    try:
        result = response.json()
    except Exception:
        raise RuntimeError(
            f"企业微信返回非JSON，HTTP状态码：{response.status_code}，返回内容：{response.text}"
        )

    if response.status_code != 200 or result.get("errcode") != 0:
        raise RuntimeError(
            f"企业微信推送失败，HTTP状态码：{response.status_code}，返回内容：{result}"
        )

    logging.info("企业微信推送成功")


def send_error_message(error):
    """
    程序异常时，尝试推送错误信息到企业微信。
    """
    try:
        err_content = f"【经营简报推送失败】\n{str(error)}"
        send_wecom_message(err_content, msgtype="text")
    except Exception as e:
        logging.error("异常信息推送企业微信失败：%s", e)


def main():
    args = parse_args()
    biz_date = get_biz_date(args.biz_date)

    logging.info("当前业务日期：%s", biz_date)

    try:
        if args.only_test_wecom:
            send_wecom_message(
                f"企业微信机器人测试成功。\n业务日期：{biz_date}",
                msgtype=args.msgtype
            )
            return

        if args.only_test_db:
            test_db_connection()
            return

        sql = load_sql(args.sql_file, biz_date)
        message = run_sql(sql)
        send_wecom_message(message, msgtype=args.msgtype)

        logging.info("执行完成")

    except Exception as e:
        logging.exception("程序执行失败")
        send_error_message(e)
        sys.exit(1)


if __name__ == "__main__":
    main()