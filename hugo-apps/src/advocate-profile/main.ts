import { createApp } from 'vue';
import App from './App.vue';

const mount = document.getElementById('advocate-profile-mount');
if (mount) {
  const apiUrl = mount.getAttribute('data-api') || '';
  if (apiUrl) {
    createApp(App, { apiUrl }).mount(mount);
  }
}
