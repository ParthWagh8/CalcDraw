import {createBrowserRouter, RouterProvider} from 'react-router-dom';

import Home from '@/screens/home';

import '@/index.css';

const paths = [
    {
        path: '/',
        element: (
          <Home/>
        ),
    },
];

const BrowserRouter = createBrowserRouter(paths);

const App = () => {
    return (
      <RouterProvider router={BrowserRouter}/>
    )
};

export default App;
