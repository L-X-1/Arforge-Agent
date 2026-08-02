from django.test import Client
from selenium import webdriver
from selenium.webdriver.common.by import By

from web_platform.django_app import reset_items
from web_platform.flask_app import create_flask_app


def test_django_and_flask_clients_execute_same_contract():
    reset_items()
    django_client = Client()
    django_response = django_client.post(
        "/items",
        data='{"title":"django"}',
        content_type="application/json",
    )
    flask_response = create_flask_app().test_client().post(
        "/items",
        json={"title": "flask"},
    )

    assert django_response.status_code == 201
    assert django_response.json()["title"] == "django"
    assert flask_response.status_code == 201
    assert flask_response.get_json()["title"] == "flask"


def test_selenium_drives_a_real_headless_browser():
    options = webdriver.ChromeOptions()
    options.add_argument("--headless=new")
    options.add_argument("--disable-gpu")
    options.add_argument("--no-sandbox")
    driver = webdriver.Chrome(options=options)
    try:
        driver.get("data:text/html,<main id='status'>project-depth</main>")
        assert driver.find_element(By.ID, "status").text == "project-depth"
    finally:
        driver.quit()
