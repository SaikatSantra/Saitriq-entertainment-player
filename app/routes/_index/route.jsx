import { redirect, Form, useLoaderData } from "react-router";
import { login } from "../../shopify.server";
import styles from "./styles.module.css";

export const loader = async ({ request }) => {
  const url = new URL(request.url);

  if (url.searchParams.get("shop")) {
    throw redirect(`/app?${url.searchParams.toString()}`);
  }

  return { showForm: Boolean(login) };
};

export default function App() {
  const { showForm } = useLoaderData();

  return (
    <div className={styles.index}>
      <div className={styles.content}>
        <h1 className={styles.heading}>Audio &amp; Video Playlist</h1>
        <p className={styles.text}>
          Turn your storefront into a polished media hub with a floating playlist widget.
        </p>
        {showForm && (
          <Form className={styles.form} method="post" action="/auth/login">
            <label className={styles.label}>
              <span>Shop domain</span>
              <input
                className={styles.input}
                type="text"
                name="shop"
                placeholder="your-store.myshopify.com"
              />
              <span>Example: your-store.myshopify.com</span>
            </label>
            <button className={styles.button} type="submit">
              Log in
            </button>
          </Form>
        )}
        <ul className={styles.list}>
          <li>
            <strong>Curated playlist</strong>. Add and reorder audio and video items
            for a clean storefront experience.
          </li>
          <li>
            <strong>Floating widget</strong>. Keep the player visible while customers
            browse your store.
          </li>
          <li>
            <strong>Flexible media sources</strong>. Support YouTube, TikTok,
            Instagram, Facebook, and direct MP4/MP3 files.
          </li>
        </ul>
      </div>
    </div>
  );
}
